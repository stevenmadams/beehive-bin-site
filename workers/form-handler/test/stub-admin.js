import { WorkerEntrypoint } from 'cloudflare:workers';

/* The admin Worker's Billing entrypoint, as the confirmation flow sees it.
   Storing a card and charging the rental are recorded and, by default,
   succeed — a test can flip either to fail. The real thing is tested on the
   admin side against the fake Square. */
const calls = [];
let fail = {};

export class Billing extends WorkerEntrypoint {
  async storeCardForRental(token, payload) {
    calls.push({ op: 'storeCard', token, payload });
    if (fail.storeCard) return { ok: false, error: fail.storeCard };
    await this.env.DB.prepare(
      "UPDATE rentals SET square_card_id = 'card_1', card_brand = 'VISA', card_last4 = '4242', card_stored_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE confirm_token = ?1",
    ).bind(token).run();
    return { ok: true, brand: 'VISA', last4: '4242' };
  }
  async chargeRental(token) {
    calls.push({ op: 'charge', token });
    if (fail.charge) return { ok: false, error: fail.charge };
    await this.env.DB.prepare(
      `UPDATE rentals SET square_invoice_id = 'inv_1', square_invoice_url = 'https://squareup.com/pay-invoice/inv_1',
         square_status = 'PAID', paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), status = 'confirmed'
       WHERE confirm_token = ?1`,
    ).bind(token).run();
    return { ok: true, status: 'PAID' };
  }
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/reset') { calls.length = 0; fail = {}; return new Response('ok'); }
    if (url.pathname === '/fail') { fail = Object.fromEntries(url.searchParams); return new Response('ok'); }
    return Response.json(calls);
  }
}
export default { fetch: () => new Response('stub') };
