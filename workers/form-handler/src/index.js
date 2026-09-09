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
    required: ['bins', 'weeks', 'start', 'dcity', 'fname', 'phone'],
    fields: [
      ['bins', 'Package'], ['weeks', 'Weeks'], ['start', 'Start date'],
      ['return_date', 'Return date'], ['total_before_tax', 'Total (before tax)'],
      ['dcity', 'Delivery city'], ['pcity', 'Pickup city'],
      ['fname', 'First name'], ['lname', 'Last name'],
      ['phone', 'Phone'], ['email', 'Email'],
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

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [INBOX],
        subject,
        text: `New ${data.form} submission from beehivebin.co\n\n${lines.join('\n')}\n`,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      console.log('resend error', res.status, await res.text());
      return json({ ok: false, error: 'send failed' }, 502, origin);
    }
    return json({ ok: true }, 200, origin);
  },
};
