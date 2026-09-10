/* Square Invoices, for the money half of a rental.

   What this does NOT do: the rental agreement. Square Contracts has no public
   API, so e-signature stays a manual step in the Square dashboard — see
   docs/stage2-square-automation.md. Only the invoice is automated here. */

const HOSTS = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
};
// Pinned: Square dates its API, and an unpinned client silently changes
// behaviour underneath us when they ship a new version.
const SQUARE_VERSION = '2025-01-23';

export class SquareError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function client(env) {
  const host = HOSTS[env.SQUARE_ENV] || HOSTS.sandbox;
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new SquareError('Square is not connected yet (no access token).', 503);
  if (!env.SQUARE_LOCATION_ID) throw new SquareError('Square is not connected yet (no location id).', 503);

  return async (method, path, body) => {
    const res = await fetch(`${host}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      // Square returns a list of errors; the first one's detail is the useful bit.
      const first = data.errors?.[0];
      throw new SquareError(first?.detail || `Square returned ${res.status}`, res.status, data.errors);
    }
    return data;
  };
}

const uuid = () => crypto.randomUUID();

/* Reuse a customer when we already have their id on a previous rental, so a
   repeat renter stays one person in Square rather than accumulating duplicates. */
async function findOrCreateCustomer(call, env, rental) {
  if (rental.square_customer_id) return rental.square_customer_id;

  const prior = await env.DB.prepare(
    `SELECT square_customer_id FROM rentals
     WHERE square_customer_id IS NOT NULL AND email IS NOT NULL AND lower(email) = lower(?1)
     ORDER BY id DESC LIMIT 1`,
  ).bind(rental.email || '').first();
  if (prior?.square_customer_id) return prior.square_customer_id;

  const { customer } = await call('POST', '/v2/customers', {
    idempotency_key: uuid(),
    given_name: rental.first_name || undefined,
    family_name: rental.last_name || undefined,
    email_address: rental.email || undefined,
    phone_number: rental.phone || undefined,
    reference_id: `rental-${rental.id}`,
    note: `Beehive Bin Co. rental #${rental.id}`,
  });
  return customer.id;
}

const money = cents => ({ amount: Math.round(cents), currency: 'USD' });

/* Sales tax.

   Square does NOT apply a location's tax settings to orders created through the
   API — an order without a tax on it is simply untaxed, however the dashboard is
   configured. The rate has to be attached here.

   Preferred form is a Tax object created in the Square dashboard, referenced by
   id: the rate then lives where the business's accounting already is, changes
   without a deploy, and shows up correctly in Square's tax reporting. A plain
   percentage is supported as a fallback for getting started.

   If neither is configured no tax is added, which is the honest behaviour —
   inventing a rate would be worse than charging none. `ping` reports which of
   the two is in force so this cannot be silently wrong. */
function taxesFor(env) {
  const catalogId = (env.SQUARE_TAX_CATALOG_ID || '').trim();
  if (catalogId) {
    return { taxes: [{ catalog_object_id: catalogId, scope: 'ORDER' }] };
  }

  const pct = (env.SQUARE_TAX_PERCENTAGE || '').trim();
  if (pct) {
    return {
      taxes: [{
        name: env.SQUARE_TAX_NAME || 'Sales tax',
        percentage: pct,          // Square wants a string, e.g. "7.25"
        scope: 'ORDER',
        type: 'ADDITIVE',         // added on top, not carved out of the price
      }],
    };
  }
  return {};
}


/* Creates customer -> order -> invoice, then publishes it, which is what
   actually emails the customer a payment link. Returns the ids to store on the
   rental so the webhook can find its way back here. */
export async function createInvoice(env, rental) {
  const call = client(env);
  if (!rental.total_cents || rental.total_cents <= 0) {
    throw new SquareError('This rental has no total to invoice.', 400);
  }
  if (!rental.email) {
    throw new SquareError('Square needs an email address for the customer record.', 400);
  }

  const customerId = await findOrCreateCustomer(call, env, rental);
  const weeks = rental.weeks === 1 ? '1 week' : `${rental.weeks} weeks`;

  const { order } = await call('POST', '/v2/orders', {
    idempotency_key: uuid(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      customer_id: customerId,
      reference_id: `rental-${rental.id}`,
      line_items: [{
        name: `${rental.bins} moving bins — ${weeks}`,
        quantity: '1',
        base_price_money: money(rental.total_cents),
        note: `Delivered ${rental.start_date}, back by ${rental.due_date}`,
      }],
      ...taxesFor(env),
    },
  });

  const { invoice } = await call('POST', '/v2/invoices', {
    idempotency_key: uuid(),
    invoice: {
      location_id: env.SQUARE_LOCATION_ID,
      order_id: order.id,
      primary_recipient: { customer_id: customerId },
      // Due on the delivery date: the bins should not leave unpaid.
      payment_requests: [{
        request_type: 'BALANCE',
        due_date: rental.start_date,
        automatic_payment_source: 'NONE',
      }],
      // We send the customer one link — our own confirmation page — and it
      // hands off to this invoice. Letting Square email its own copy as well
      // would put two competing "pay now" messages in the same inbox.
      delivery_method: 'SHARE_MANUALLY',
      accepted_payment_methods: { card: true, bank_account: false },
      title: `Bin rental — ${rental.bins} bins, ${weeks}`,
      description: `Delivery ${rental.start_date} · pickup ${rental.due_date}.`,
      sale_or_service_date: rental.start_date,
    },
  });

  const published = await call('POST', `/v2/invoices/${invoice.id}/publish`, {
    idempotency_key: uuid(),
    version: invoice.version,
  });

  return {
    square_customer_id: customerId,
    square_order_id: order.id,
    square_invoice_id: published.invoice.id,
    square_invoice_url: published.invoice.public_url || null,
    square_status: published.invoice.status || null,
  };
}

/* Used to reconcile by hand when a webhook was missed. */
export async function fetchInvoice(env, invoiceId) {
  const call = client(env);
  const { invoice } = await call('GET', `/v2/invoices/${invoiceId}`);
  return invoice;
}

/* Read-only connection check. Listing locations touches no customer data and
   sends nothing, so it is safe to run before the first real invoice — it
   catches the common mismatch of a production token against a sandbox location
   (or vice versa), which otherwise only surfaces when a customer is emailed. */
export async function ping(env) {
  const call = client(env);
  const { locations = [] } = await call('GET', '/v2/locations');
  const match = locations.find(l => l.id === env.SQUARE_LOCATION_ID);
  const tax = env.SQUARE_TAX_CATALOG_ID ? `catalog ${env.SQUARE_TAX_CATALOG_ID}`
    : env.SQUARE_TAX_PERCENTAGE ? `${env.SQUARE_TAX_PERCENTAGE}% (inline)`
    : 'NOT CONFIGURED — invoices will be raised with no sales tax';

  return {
    env: env.SQUARE_ENV || 'sandbox',
    tax,
    location_id: env.SQUARE_LOCATION_ID,
    location_found: !!match,
    location_name: match?.name || null,
    currency: match?.currency || null,
    status: match?.status || null,
    other_locations: locations.filter(l => l.id !== env.SQUARE_LOCATION_ID).map(l => l.id),
  };
}
