import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { rentalWithLink, rental, audit } from './helpers.js';

async function sign(body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-signing-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('https://api.beehivebin.co/square/webhook' + body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
async function webhook(event, { signature } = {}) {
  const body = JSON.stringify(event);
  const res = await SELF.fetch('https://api.beehivebin.co/square/webhook', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature ?? await sign(body) },
  });
  return { status: res.status, text: await res.text() };
}
const paidEvent = (invoiceId, eventId = crypto.randomUUID()) => ({
  event_id: eventId, type: 'invoice.payment_made',
  data: { object: { invoice: { id: invoiceId, status: 'PAID' } } },
});

describe('Square telling us money arrived', () => {
  it('a signed invoice.payment_made marks the rental paid and confirmed', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("UPDATE rentals SET square_invoice_id = 'inv_77', agreement_signed_at = 'x' WHERE id = ?1").bind(r.id).run();
    const res = await webhook(paidEvent('inv_77'));
    expect(res.status).toBe(200);
    const row = await rental(r.id);
    expect(row.paid_at).toBeTruthy();
    expect(row.square_status).toBe('PAID');
    expect(row.status).toBe('confirmed');
    expect((await audit()).find(e => e.actor_email === 'square-webhook')).toMatchObject({ action: 'square.invoice.payment_made' });
  });

  it('a bad signature is refused and nothing changes', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("UPDATE rentals SET square_invoice_id = 'inv_78' WHERE id = ?1").bind(r.id).run();
    expect((await webhook(paidEvent('inv_78'), { signature: 'nope' })).status).toBe(401);
    expect((await webhook(paidEvent('inv_78'), { signature: '' })).status).toBe(401);
    expect((await rental(r.id)).paid_at).toBeNull();
  });

  it('the same event delivered twice is handled once', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("UPDATE rentals SET square_invoice_id = 'inv_79' WHERE id = ?1").bind(r.id).run();
    const ev = paidEvent('inv_79', 'evt_same');
    await webhook(ev);
    const first = (await rental(r.id)).paid_at;
    expect((await webhook(ev)).text).toMatch(/already/);
    expect((await audit()).filter(e => e.actor_email === 'square-webhook')).toHaveLength(1);
    expect((await rental(r.id)).paid_at).toBe(first);
  });

  it('a later non-PAID status never clears a payment', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("UPDATE rentals SET square_invoice_id = 'inv_80', paid_at = '2026-09-01T00:00:00Z' WHERE id = ?1").bind(r.id).run();
    await webhook({ event_id: crypto.randomUUID(), type: 'invoice.updated', data: { object: { invoice: { id: 'inv_80', status: 'UNPAID' } } } });
    expect((await rental(r.id)).paid_at).toBe('2026-09-01T00:00:00Z');
  });

  it('settles an extension, and every charge sharing one invoice', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("INSERT INTO rental_extensions (rental_id, weeks, amount_cents, previous_due_date, new_due_date, created_by, square_invoice_id) VALUES (?1, 1, 4000, '2026-09-20', '2026-09-27', 'test', 'inv_ext')").bind(r.id).run();
    await env.DB.prepare("INSERT INTO charges (rental_id, kind, qty, unit_cents, amount_cents, reason, created_by, square_invoice_id) VALUES (?1,'late',1,4000,4000,'late','test','inv_chg'), (?1,'missing',2,1500,3000,'lost','test','inv_chg')").bind(r.id).run();
    await webhook(paidEvent('inv_ext'));
    await webhook(paidEvent('inv_chg'));
    const ext = await env.DB.prepare('SELECT paid_at, square_status FROM rental_extensions').first();
    expect(ext).toMatchObject({ square_status: 'PAID' });
    expect(ext.paid_at).toBeTruthy();
    const { results } = await env.DB.prepare('SELECT paid_at FROM charges').all();
    expect(results.every(c => c.paid_at)).toBe(true);
    // The rental itself is untouched by either.
    expect((await rental(r.id)).paid_at).toBeNull();
  });

  it('an unknown invoice is acknowledged (so Square stops retrying) and logged', async () => {
    expect((await webhook(paidEvent('inv_nobody'))).status).toBe(200);
  });
});
