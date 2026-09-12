import { SELF, env } from 'cloudflare:test';

export const today = (n = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const weekday = (n = 3) => { let d = today(n); while (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = today(++n); return d; };
export const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* The website's form, as a browser would send it. */
export async function submit(fields, origin = 'https://beehivebin.co') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await SELF.fetch('https://api.beehivebin.co/submit', { method: 'POST', body: fd, headers: { Origin: origin } });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

export const reserveForm = (over = {}) => ({
  form: 'reserve', bins: '20', weeks: '1', start: weekday(4), return_date: 'x', total_before_tax: '$79',
  dcity: 'Clinton', fname: 'Dana', lname: 'Whitfield', phone: '801-555-0100', email: 'dana@example.com',
  contact_pref: 'text', notes: 'Gate code 4471', ...over,
});

/* A rental with a confirmation link, as the panel would have made it. */
export async function rentalWithLink(over = {}) {
  const token = crypto.randomUUID();
  const r = { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', phone: '801-555-0100',
    bins: 20, weeks: 1, start_date: weekday(4), total_cents: 7900, delivery_city: 'Clinton', status: 'pending', ...over };
  const res = await env.DB.prepare(
    `INSERT INTO rentals (created_by, first_name, last_name, email, phone, bins, weeks, start_date, due_date,
       total_cents, delivery_city, pickup_city, status, confirm_token, confirm_sent_at)
     VALUES ('test', ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  ).bind(r.first_name, r.last_name, r.email, r.phone, r.bins, r.weeks, r.start_date, addDays(r.start_date, 7 * r.weeks),
         r.total_cents, r.delivery_city, r.status, token).run();
  return { id: res.meta.last_row_id, token, ...r };
}

export const link = token => `https://book.beehivebin.co/${token}`;

export async function open(token, step) {
  const res = await SELF.fetch(link(token) + (step ? `?step=${step}` : ''), { redirect: 'manual' });
  return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}

export async function post(token, fields, extra = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await SELF.fetch(link(token), { method: 'POST', body: fd, redirect: 'manual',
    headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'TestBrowser/1.0', ...extra } });
  return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}

export async function card(token, body) {
  const res = await SELF.fetch(`${link(token)}/card`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

export const rental = id => env.DB.prepare('SELECT * FROM rentals WHERE id = ?1').bind(id).first();
export const requests = () => env.DB.prepare('SELECT * FROM requests ORDER BY id').all().then(r => r.results);
export const mail = async () => (await env.WORLD.fetch('http://stub/mail')).json();
export const billing = async () => (await env.ADMIN_STUB.fetch('http://stub/calls')).json();
export const billingFails = what => env.ADMIN_STUB.fetch(`http://stub/fail?${new URLSearchParams(what)}`);
export const audit = () => env.DB.prepare('SELECT action, actor_email, detail FROM audit_log ORDER BY id').all().then(r => r.results);
