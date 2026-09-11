/* Square Invoices, for the money half of a rental.

   What this does NOT do: the rental agreement. Square Contracts has no public
   API, so e-signature stays a manual step in the Square dashboard — see
   docs/stage2-square-automation.md. Only the invoice is automated here. */

import { rateFor, TaxError, TAX_TABLE_VERIFIED, TAX_TABLE_SOURCE } from './tax.js';

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

   Square does NOT apply a location's tax settings to an order built from an
   ad-hoc line item, so the rate is attached here explicitly.

   Utah sources a rental to where the customer receives the property, so the
   rate comes from the delivery city rather than from ours — and the cities we
   serve do not all charge the same. The rate is looked up per rental in
   tax.js.

   The date used is the DELIVERY date, on the reasoning that the lease begins
   when the customer receives the bins, which is the same event that decides the
   jurisdiction. An invoice raised in September for an October delivery
   therefore uses October's rate. This is the defensible reading rather than a
   settled one — it is on the list to confirm with the Tax Commission, and it is
   a one-line change if they say otherwise. */
function taxesFor(rental, onDate, scope = 'ORDER') {
  const { rate } = rateFor(rental.delivery_city, onDate || rental.start_date);
  return {
    taxes: [{
      uid: TAX_UID,
      name: 'Utah sales tax',
      percentage: rate,
      scope,
      type: 'ADDITIVE',   // added on top, matching "plus tax" everywhere else
    }],
  };
}

const TAX_UID = 'utah-sales-tax';



/* Creates customer -> order -> invoice, then publishes it, which is what
   actually emails the customer a payment link. Returns the ids to store on the
   rental so the webhook can find its way back here. */
export async function createInvoice(env, rental, override) {
  const call = client(env);

  /* One line, or several. A rental invoice is a single package; a charges
     invoice is "$65 late, $30 for two cracked bins" — itemised, because a
     customer disputing a lump sum is a customer you have already lost. */
  const lines = override?.lineItems?.length ? override.lineItems : null;
  const amountCents = lines
    ? lines.reduce((n, l) => n + l.amountCents, 0)
    : override?.amountCents ?? rental.total_cents;
  if (!amountCents || amountCents <= 0) {
    throw new SquareError('There is no amount to invoice.', 400);
  }
  if (!rental.email) {
    throw new SquareError('Square needs an email address for the customer record.', 400);
  }

  // Refuse rather than invoice untaxed: an unknown jurisdiction is a question
  // for a human, and undercollecting is the expensive direction to be wrong in.
  try {
    rateFor(rental.delivery_city, override?.serviceDate || rental.start_date);
  } catch (err) {
    if (err instanceof TaxError) throw new SquareError(err.message, 400);
    throw err;
  }

  const customerId = await findOrCreateCustomer(call, env, rental);
  const weeks = rental.weeks === 1 ? '1 week' : `${rental.weeks} weeks`;

  /* Tax hangs off the order as a whole when everything on it is taxable, and
     off individual lines when it is not — a replacement charge whose treatment
     the Tax Commission has not answered yet can be marked untaxed without
     dropping tax from the late fee sitting next to it. */
  const mixed = lines ? lines.some(l => l.taxable === false) : false;
  const lineItems = lines
    ? lines.map((l, i) => ({
        uid: `line-${i}`,
        name: l.name,
        quantity: String(l.quantity ?? 1),
        // Priced per unit, never amount/quantity — two bins at $15 must invoice
        // as 2 × $15, not as one $30 line that rounds if the maths is uneven.
        base_price_money: money(l.unitCents ?? l.amountCents),
        note: l.note || undefined,
        ...(mixed && l.taxable !== false
          ? { applied_taxes: [{ tax_uid: TAX_UID }] }
          : {}),
      }))
    : [{
        name: override?.lineName || `${rental.bins} moving bins — ${weeks}`,
        quantity: '1',
        base_price_money: money(amountCents),
        note: override?.lineNote || `Delivered ${rental.start_date}, back by ${rental.due_date}`,
      }];

  const { order } = await call('POST', '/v2/orders', {
    idempotency_key: uuid(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      customer_id: customerId,
      reference_id: override?.referenceId || `rental-${rental.id}`,
      line_items: lineItems,
      ...(mixed && !lines.some(l => l.taxable !== false)
        ? {}
        : taxesFor(rental, override?.serviceDate, mixed ? 'LINE_ITEM' : 'ORDER')),
    },
  });

  const { invoice } = await call('POST', '/v2/invoices', {
    idempotency_key: uuid(),
    invoice: {
      location_id: env.SQUARE_LOCATION_ID,
      order_id: order.id,
      primary_recipient: { customer_id: customerId },
      // Due on the delivery date: the bins should not leave unpaid. An extension
      // is already under way, so it is due now.
      payment_requests: [{
        request_type: 'BALANCE',
        due_date: override?.dueDate || rental.start_date,
        ...(override?.cardId
          ? { automatic_payment_source: 'CARD_ON_FILE', card_id: override.cardId }
          : { automatic_payment_source: 'NONE' }),
      }],
      /* Square REQUIRES delivery_method EMAIL for an automatic card-on-file
         charge — with SHARE_MANUALLY the invoice publishes cleanly and then
         simply never charges, which is exactly what happened here.

         The original reason for SHARE_MANUALLY was to avoid two competing "pay
         now" messages. That reason disappears once the card is charged on
         publish: Square's email is then a receipt, not a demand. Without a card
         we still send nothing, because our own link is the only thing that
         should be asking for money. */
      delivery_method: override?.cardId ? 'EMAIL' : 'SHARE_MANUALLY',
      accepted_payment_methods: { card: true, bank_account: false },
      /* Offers the payer a "save my card on file" checkbox. Defaults to false,
         which left §4 of the rental agreement — charging for late returns and
         damage without a further signature — with no card to charge. It is the
         customer's choice, so a stored card is never guaranteed; what this does
         is make it possible at the one moment they are already paying. */
      store_payment_method_enabled: true,
      title: override?.title || `Bin rental — ${rental.bins} bins, ${weeks}`,
      description: override?.description || `Delivery ${rental.start_date} · pickup ${rental.due_date}.`,
      sale_or_service_date: override?.serviceDate || rental.start_date,
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
  const tax = `${TAX_TABLE_SOURCE}; verified ${TAX_TABLE_VERIFIED} — re-check each quarter at tax.utah.gov/sales/ratechanges`;

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

/* Exchange a single-use token from the Web Payments SDK for a card stored
   against the customer.

   The token is created in the customer's browser and is worthless afterwards;
   the card number never touches our servers, which is what keeps this out of
   PCI scope. What comes back is an id we can charge later under §4, plus the
   brand and last four so a human can recognise it. */
export async function storeCard(env, { customerId, sourceId, verificationToken, holderName, postalCode }) {
  const call = client(env);
  const { card } = await call('POST', '/v2/cards', {
    idempotency_key: uuid(),
    source_id: sourceId,
    ...(verificationToken ? { verification_token: verificationToken } : {}),
    card: {
      customer_id: customerId,
      cardholder_name: holderName || undefined,
      billing_address: postalCode ? { postal_code: postalCode } : undefined,
      reference_id: `rental-card`,
    },
  });
  return {
    id: card.id,
    brand: card.card_brand || null,
    last4: card.last_4 || null,
    exp: card.exp_month && card.exp_year ? `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}` : null,
  };
}

/* A customer record has to exist before a card can hang off it. Created here
   rather than at invoice time, because the card now comes first. */
export async function ensureCustomer(env, rental) {
  const call = client(env);
  return findOrCreateCustomer(call, env, rental);
}
