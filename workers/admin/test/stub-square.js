/* A fake Square. Every outbound fetch from the Worker under test lands here.

   It answers the handful of endpoints the code uses with the shapes the real
   API returns, and keeps every request so a test can assert what was sent —
   "the invoice had two line items and a 7.25% tax" is the thing worth
   checking, not that a fetch happened. */
const calls = [];
let n = 0;
const id = p => `${p}_${++n}`;
const invoices = new Map();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;

    // Test-side controls.
    if (url.hostname === 'stub') {
      if (url.pathname === '/calls') return Response.json(calls);
      if (url.pathname === '/reset') { calls.length = 0; invoices.clear(); return new Response('ok'); }
      if (url.pathname === '/pay') {   // mark an invoice paid, as the customer would
        const inv = invoices.get(url.searchParams.get('id'));
        if (inv) inv.status = 'PAID';
        return new Response('ok');
      }
    }

    if (!url.hostname.includes('squareup')) {
      calls.push({ host: url.hostname, path: url.pathname });
      return new Response('not mocked', { status: 502 });
    }
    calls.push({ method: request.method, path: url.pathname, body });

    if (url.pathname === '/v2/locations') {
      return Response.json({ locations: [{ id: 'LJR9D95SRQSN7', name: 'Test', currency: 'USD', status: 'ACTIVE' }] });
    }
    if (url.pathname === '/v2/customers') return Response.json({ customer: { id: id('cust') } });
    if (url.pathname === '/v2/orders') return Response.json({ order: { id: id('order'), ...body.order } });
    if (url.pathname === '/v2/cards') {
      return Response.json({ card: { id: id('card'), card_brand: 'VISA', last_4: '1111', exp_month: 12, exp_year: 2030 } });
    }
    if (url.pathname === '/v2/invoices' && request.method === 'POST') {
      const inv = { id: id('inv'), version: 0, status: 'DRAFT', ...body.invoice };
      invoices.set(inv.id, inv);
      return Response.json({ invoice: inv });
    }
    const pub = /^\/v2\/invoices\/([^/]+)\/publish$/.exec(url.pathname);
    if (pub) {
      const inv = invoices.get(pub[1]);
      inv.status = inv.payment_requests?.[0]?.automatic_payment_source === 'CARD_ON_FILE' ? 'PAID' : 'UNPAID';
      inv.public_url = `https://squareup.com/pay-invoice/${inv.id}`;
      inv.version = 1;
      return Response.json({ invoice: inv });
    }
    const get = /^\/v2\/invoices\/([^/]+)$/.exec(url.pathname);
    if (get && request.method === 'GET') {
      const inv = invoices.get(get[1]);
      return inv ? Response.json({ invoice: inv }) : Response.json({ errors: [{ detail: 'not found' }] }, { status: 404 });
    }
    return Response.json({ errors: [{ detail: `stub: no handler for ${request.method} ${url.pathname}` }] }, { status: 500 });
  },
};
