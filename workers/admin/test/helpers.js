import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';

export const OWNER = 'owner@beehivebin.co';
export const STAFF = 'staff@beehivebin.co';

/* Calls the API as a given person. The dev bypass reads X-Dev-Email under the
   same lock `wrangler dev` uses, so the first address through becomes owner
   and the rest staff — exactly the production enrolment rule. */
export async function api(path, { method = 'GET', body, as = OWNER, headers = {} } = {}) {
  const res = await SELF.fetch(`https://admin.beehivebin.co/api${path}`, {
    method,
    headers: {
      'x-dev-email': as,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json, body: json };
}

/* Most tests want the call to have worked and to get at the payload. */
export async function ok(path, opts) {
  const r = await api(path, opts);
  expect(r.status, `${opts?.method || 'GET'} ${path} → ${r.error || ''}`).toBeLessThan(300);
  return r;
}

export const today = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/* A weekday `n` days out — deliveries are never on Sundays, so tests that need
   a bookable date should ask for one. */
export const weekday = (offsetDays = 3) => {
  let d = today(offsetDays);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = today(++offsetDays);
  return d;
};

export async function ensureOwner() {
  await api('/me', { as: OWNER });
}

/* The fleet: N good bins, added as the owner. */
export async function fleet(n, kind = 'bin') {
  await ensureOwner();
  return ok('/items', { method: 'POST', body: { kind, count: n } });
}

/* A reservation, as if it came off the website. */
export async function request(over = {}) {
  await ensureOwner();
  const r = await ok('/requests', { method: 'POST', body: {
    kind: 'reserve', first_name: 'Dana', last_name: 'Whitfield',
    email: 'dana@example.com', phone: '801-555-0100', contact_pref: 'text',
    bins: 20, weeks: 1, start_date: weekday(3), delivery_city: 'Clinton',
    ...over,
  }});
  return r.request;
}

/* A rental, straight from an approved request. */
export async function rental(over = {}) {
  const req = await request(over);
  const r = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve', ...(over.force ? { force: true } : {}) } });
  return (await ok(`/rentals/${r.rental_id}`)).rental;
}

/* Poke the database directly when a scenario needs history that the API
   rightly refuses to fabricate (a rental that went out last month, say). */
export const sql = (q, ...binds) => env.DB.prepare(q).bind(...binds).run();
export const row = (q, ...binds) => env.DB.prepare(q).bind(...binds).first();

export const sent = async () => (await env.MAILER.fetch('http://stub/sent')).json();
export const clearSent = () => env.MAILER.fetch('http://stub/reset');

/* The fake Square: what was asked of it, and a way to "pay" an invoice. */
export const squareCalls = async () => (await env.SQUARE_STUB.fetch('http://stub/calls')).json();
export const squareReset = () => env.SQUARE_STUB.fetch('http://stub/reset');
export const squarePay = id => env.SQUARE_STUB.fetch(`http://stub/pay?id=${id}`);

// A 1x1 PNG is enough to be a photo.
export const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
export async function photo(id, kind, as = OWNER) {
  const res = await SELF.fetch(`https://admin.beehivebin.co/api/rentals/${id}/photos?kind=${kind}`, {
    method: 'POST', headers: { 'x-dev-email': as, 'content-type': 'image/png' }, body: PNG,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
