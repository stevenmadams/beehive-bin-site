/* Beehive Bin Co. — form handler.
   Receives reserve/contact form POSTs from beehivebin.co and emails them to
   the shared inbox via Resend. Stage 2 (Square pipeline) builds on this. */

const INBOX = 'support@beehivebin.co';
const FROM = 'Beehive Bin Co. site <noreply@beehivebin.co>';
const ALLOWED_ORIGINS = [
  'https://beehivebin.co',
  'https://www.beehivebin.co',
  'http://localhost:8741', // local preview
];

const cors = origin => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });

// Field allowlists double as email line ordering.
const FORMS = {
  reserve: {
    subjectField: '_subject',
    required: ['bins', 'weeks', 'start', 'dcity', 'fname', 'phone', 'email'],
    fields: [
      ['bins', 'Package'], ['weeks', 'Weeks'], ['start', 'Start date'],
      ['return_date', 'Return date'], ['total_before_tax', 'Total (before tax)'],
      ['dcity', 'Delivery city'], ['pcity', 'Pickup city'],
      ['fname', 'First name'], ['lname', 'Last name'],
      ['phone', 'Phone'], ['email', 'Email'],
      ['notes', 'Customer notes'],
    ],
  },
  contact: {
    required: ['name', 'contact', 'message'],
    fields: [
      ['name', 'Name'], ['contact', 'Phone / Email'], ['city', 'City'],
      ['movedate', 'Needs bins around'], ['message', 'Message'],
    ],
  },
};

/* ---------- D1 persistence ----------
   Every submission becomes a row in `requests`, which is what the admin panel
   at admin.beehivebin.co reads. The email is now a notification, not the
   record of truth. */

const trim = (v, max = 500) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const int = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? '').trim());
// "$129" / "$1,299.50" -> cents. The form sends a display string, not a number.
const centsFrom = v => {
  const m = /([\d,]+(?:\.\d{1,2})?)/.exec(String(v ?? ''));
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : null;
};
// <input type="date"> gives yyyy-mm-dd; reject anything else rather than
// storing junk in a column the schedule will later sort on.
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);

async function storeRequest(env, data) {
  const contact = trim(data.contact, 200);
  const row = data.form === 'reserve'
    ? {
        first_name: trim(data.fname, 100),
        last_name: trim(data.lname, 100),
        email: trim(data.email, 200),
        phone: trim(data.phone, 40),
        bins: int(data.bins),
        weeks: int(data.weeks),
        start_date: isoDate(data.start),
        return_date: trim(data.return_date, 60),
        quoted_total_cents: centsFrom(data.total_before_tax),
        delivery_city: trim(data.dcity, 120),
        pickup_city: trim(data.pcity, 120),
        customer_notes: trim(data.notes, 4000),
        message: null,
      }
    : {
        first_name: trim(data.name, 100),
        last_name: null,
        // The contact form takes one "phone or email" box; sort it here so the
        // panel can show a usable contact method without guessing.
        email: isEmail(contact) ? contact : null,
        phone: isEmail(contact) ? null : contact,
        bins: null,
        weeks: null,
        start_date: isoDate(data.movedate),
        return_date: null,
        quoted_total_cents: null,
        delivery_city: trim(data.city, 120),
        pickup_city: null,
        customer_notes: null,
        message: trim(data.message, 4000),
      };

  const res = await env.DB.prepare(
    `INSERT INTO requests (kind, first_name, last_name, email, phone, bins, weeks,
       start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
       customer_notes, message, raw_json)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
  ).bind(
    data.form, row.first_name, row.last_name, row.email, row.phone, row.bins, row.weeks,
    row.start_date, row.return_date, row.quoted_total_cents, row.delivery_city, row.pickup_city,
    row.customer_notes, row.message, JSON.stringify(data).slice(0, 8000),
  ).run();

  return res.meta.last_row_id;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === 'GET') return new Response('beehive-forms ok', { status: 200 });
    if (request.method !== 'POST' || url.pathname !== '/submit')
      return json({ ok: false, error: 'not found' }, 404, origin);

    let data;
    try {
      data = Object.fromEntries((await request.formData()).entries());
    } catch {
      return json({ ok: false, error: 'bad form data' }, 400, origin);
    }

    // Honeypot: hidden field humans never fill. Bots that do get a fake yes.
    if (data.website) return json({ ok: true }, 200, origin);

    const spec = FORMS[data.form];
    if (!spec) return json({ ok: false, error: 'unknown form' }, 400, origin);
    for (const f of spec.required) {
      if (!String(data[f] || '').trim()) return json({ ok: false, error: `missing ${f}` }, 400, origin);
    }

    const lines = spec.fields
      .filter(([k]) => String(data[k] || '').trim())
      .map(([k, label]) => `${label}: ${String(data[k]).trim().slice(0, 500)}`);
    const subject = String(data[spec.subjectField] || '').trim().slice(0, 120)
      || (data.form === 'reserve' ? 'Bin reservation request' : 'Contact form message');

    const replyTo = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email || data.contact || '').trim())
      ? String(data.email || data.contact).trim()
      : undefined;

    // Store and notify independently: a Resend outage must not lose the
    // request, and a D1 hiccup must not stop the owner hearing about it.
    let requestId = null;
    try {
      requestId = await storeRequest(env, data);
    } catch (err) {
      console.log('d1 insert failed', err.message);
    }

    let emailed = false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [INBOX],
          subject,
          text: `New ${data.form} submission from beehivebin.co\n\n${lines.join('\n')}\n`
            + (requestId ? `\nOpen in the panel: https://admin.beehivebin.co/#/requests/${requestId}\n` : ''),
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      emailed = res.ok;
      if (!res.ok) console.log('resend error', res.status, await res.text());
    } catch (err) {
      console.log('resend threw', err.message);
    }

    // Only tell the customer we failed if the submission reached nowhere at all.
    if (!requestId && !emailed) return json({ ok: false, error: 'send failed' }, 502, origin);
    return json({ ok: true }, 200, origin);
  },
};
