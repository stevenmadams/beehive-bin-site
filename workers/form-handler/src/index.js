import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleConfirm } from './confirm.js';
import { sendEmail, FROM, INBOX } from './mail.js';
import { serviceCity } from './tax.js';
import { quoteCents } from './pricing.js';
import { today, isoDate, addDays } from '../../shared/clock.js';
import { closedWeekdays, weekdayOf, WEEKDAY } from '../../shared/coverage.js';
import { closedHolidayOn } from '../../shared/holidays.js';

/* Beehive Bin Co. — form handler.
   Receives reserve/contact form POSTs from beehivebin.co and emails them to
   the shared inbox via Resend. Stage 2 (Square pipeline) builds on this. */

// FROM/INBOX live in mail.js so the confirmation flow and the panel's mailer
// cannot disagree about who a customer is replying to.
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
      ['contact_pref', 'Prefers'], ['notes', 'Customer notes'],
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
const CONTACT_PREFS = ['text', 'call', 'email'];
const contactPref = v => {
  const t = String(v ?? '').trim().toLowerCase();
  return CONTACT_PREFS.includes(t) ? t : null;
};
// <input type="date"> gives yyyy-mm-dd; reject anything else rather than
// storing junk in a column the schedule will later sort on.

/* What the website sends is checked here, not trusted. The form has a city
   dropdown and a package picker, but a form is a suggestion to a browser; a
   POST can say anything. Each refusal names the field so the form can show
   it, and each is something the panel would otherwise choke on later — an
   unservable city cannot be invoiced, a Sunday cannot be delivered. */
async function reserveProblem(env, data) {
  const bins = int(data.bins);
  const weeks = int(data.weeks);
  if (quoteCents(bins, 1) == null) return 'bins: pick one of our packages';
  if (!weeks || weeks < 1 || weeks > 26) return 'weeks: between 1 and 26';
  const start = isoDate(data.start);
  if (!start) return 'start: pick a date';
  if (start < today()) return 'start: that date has already passed';
  const closed = await closedWeekdays(env);
  if (closed.includes(weekdayOf(start))) return `start: we do not deliver on ${WEEKDAY[weekdayOf(start)]}s`;

  // Notice. The owner sets it; the website honours it; the panel can book
  // inside it when someone rings and the van happens to be free.
  const lead = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lead_days'").first();
  const leadDays = Math.max(0, parseInt(lead?.value ?? '1', 10) || 0);
  let earliest = addDays(today(), leadDays);
  while (closed.includes(weekdayOf(earliest))) earliest = addDays(earliest, 1);
  if (start < earliest) {
    const day = new Date(`${earliest}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return `start: we need a little notice — the earliest delivery is ${day}`;
  }
  const dayOff = await env.DB.prepare('SELECT reason FROM blackouts WHERE date = ?1').bind(start).first();
  if (dayOff) return `start: we are not delivering that day — ${dayOff.reason || 'closed'}. Pick another date`;
  const holiday = await closedHolidayOn(env, start);
  if (holiday) return `start: we are not delivering on ${holiday}. Pick another date`;
  if (!serviceCity(data.dcity)) return `dcity: we don't serve "${trim(data.dcity, 60) || ''}" yet`;
  if (trim(data.pcity) && !serviceCity(data.pcity)) return `pcity: we don't serve "${trim(data.pcity, 60)}" yet`;
  if (!isEmail(data.email)) return 'email: that address looks wrong';
  return null;
}

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
        // Quoted from the price table, never from the form: the display
        // string the page sends is for the customer's eyes, not the invoice.
        quoted_total_cents: quoteCents(int(data.bins), int(data.weeks)),
        delivery_city: serviceCity(data.dcity),
        pickup_city: trim(data.pcity) ? serviceCity(data.pcity) : null,
        customer_notes: trim(data.notes, 4000),
        message: null,
        contact_pref: contactPref(data.contact_pref),
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
        // The contact form takes one "phone or email" box, so the preference
        // is implied by whichever they typed rather than asked for.
        contact_pref: isEmail(contact) ? 'email' : contact ? 'call' : null,
      };

  const res = await env.DB.prepare(
    `INSERT INTO requests (kind, first_name, last_name, email, phone, bins, weeks,
       start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
       customer_notes, message, contact_pref, raw_json)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
  ).bind(
    data.form, row.first_name, row.last_name, row.email, row.phone, row.bins, row.weeks,
    row.start_date, row.return_date, row.quoted_total_cents, row.delivery_city, row.pickup_city,
    row.customer_notes, row.message, row.contact_pref,
    JSON.stringify(data).slice(0, 8000),
  ).run();

  return res.meta.last_row_id;
}

/* ---------- Square webhooks ----------

   This lives on the public api.beehivebin.co Worker, not the admin panel,
   because Cloudflare Access guards admin.beehivebin.co and would answer Square's
   server with a login redirect. Square has no browser and no session; the
   notification would be lost. Both Workers share the same D1 database, so the
   panel sees the result either way.

   Nothing here trusts the request until the signature checks out. */

const enc = new TextEncoder();

/* Square signs (notification_url + raw body) with the webhook signature key.
   The url must be byte-identical to what is configured in the Square dashboard,
   which is why it is a var rather than derived from the request. */
async function verifySquareSignature(env, rawBody, signature) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(env.SQUARE_WEBHOOK_URL + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Constant-time-ish compare: never bail early on the first differing byte.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const statusFrom = r => {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.returned_at) return 'returned';
  if (r.delivered_at) return 'out';
  if (r.agreement_signed_at && r.paid_at) return 'confirmed';
  return 'pending';
};

async function handleSquareWebhook(request, env) {
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY || !env.SQUARE_WEBHOOK_URL) {
    console.log('square webhook not configured');
    return new Response('not configured', { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get('x-square-hmacsha256-signature') || '';
  if (!signature || !(await verifySquareSignature(env, raw, signature))) {
    console.log('square webhook: bad signature');
    return new Response('bad signature', { status: 401 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const invoice = event?.data?.object?.invoice;
  const invoiceId = invoice?.id || null;
  const eventId = event?.event_id;
  if (!eventId) return new Response('no event id', { status: 400 });

  // Square retries on any non-2xx, so the same notification can arrive several
  // times. Recording it first makes a replay a no-op rather than a second write.
  const seen = await env.DB.prepare('SELECT handled FROM square_events WHERE event_id = ?1')
    .bind(eventId).first();
  if (seen) return new Response('already handled', { status: 200 });

  await env.DB.prepare(
    'INSERT INTO square_events (event_id, type, invoice_id, body) VALUES (?1,?2,?3,?4)',
  ).bind(eventId, event.type || null, invoiceId, raw.slice(0, 8000)).run();

  if (invoiceId) {
    /* An extension has its own invoice, so a payment can belong to either. Check
       extensions first: their ids are distinct, and a rental's own invoice will
       simply not match here. */
    const ext = await env.DB.prepare(
      'SELECT id, rental_id, paid_at FROM rental_extensions WHERE square_invoice_id = ?1',
    ).bind(invoiceId).first();

    if (ext) {
      const sqStatus = invoice.status || null;
      const paidAt = sqStatus === 'PAID'
        ? (ext.paid_at || new Date().toISOString().replace(/\.\d+/, ''))
        : ext.paid_at;
      await env.DB.prepare(
        'UPDATE rental_extensions SET square_status = ?1, paid_at = ?2 WHERE id = ?3',
      ).bind(sqStatus, paidAt, ext.id).run();
      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind('square-webhook', `square.extension.${event.type || 'event'}`, 'rental',
             String(ext.rental_id), sqStatus).run();

      await env.DB.prepare('UPDATE square_events SET handled = 1 WHERE event_id = ?1')
        .bind(eventId).run();
      return new Response('ok', { status: 200 });
    }

    /* Late fees, missing bins and damage go out on one invoice covering several
       charge rows, so this settles all of them together. */
    const { charged } = await env.DB.prepare(
      'SELECT COUNT(*) AS charged FROM charges WHERE square_invoice_id = ?1',
    ).bind(invoiceId).first();

    if (charged) {
      const sqStatus = invoice.status || null;
      const paidAt = sqStatus === 'PAID' ? new Date().toISOString().replace(/\.\d+/, '') : null;
      await env.DB.prepare(
        `UPDATE charges SET square_status = ?1, paid_at = coalesce(paid_at, ?2)
         WHERE square_invoice_id = ?3`,
      ).bind(sqStatus, paidAt, invoiceId).run();
      const row = await env.DB.prepare(
        'SELECT rental_id FROM charges WHERE square_invoice_id = ?1 LIMIT 1').bind(invoiceId).first();
      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind('square-webhook', `square.charges.${event.type || 'event'}`, 'rental',
             String(row?.rental_id ?? 0), `${charged} charge${charged === 1 ? '' : 's'} — ${sqStatus}`).run();

      await env.DB.prepare('UPDATE square_events SET handled = 1 WHERE event_id = ?1')
        .bind(eventId).run();
      return new Response('ok', { status: 200 });
    }

    const rental = await env.DB.prepare(
      `SELECT id, status, agreement_signed_at, paid_at, delivered_at, returned_at
       FROM rentals WHERE square_invoice_id = ?1`,
    ).bind(invoiceId).first();

    if (rental) {
      const sqStatus = invoice.status || null;
      // Square is the authority on whether money arrived. Only ever set paid_at
      // from a PAID invoice; never clear a payment someone recorded by hand.
      const paidAt = sqStatus === 'PAID'
        ? (rental.paid_at || new Date().toISOString().replace(/\.\d+/, ''))
        : rental.paid_at;
      const next = statusFrom({ ...rental, paid_at: paidAt });

      await env.DB.prepare(
        'UPDATE rentals SET square_status = ?1, paid_at = ?2, status = ?3 WHERE id = ?4',
      ).bind(sqStatus, paidAt, next, rental.id).run();

      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind('square-webhook', `square.${event.type || 'event'}`, 'rental',
             String(rental.id), sqStatus).run();
    } else {
      console.log('square webhook: no rental for invoice', invoiceId);
    }
  }

  await env.DB.prepare('UPDATE square_events SET handled = 1 WHERE event_id = ?1')
    .bind(eventId).run();
  return new Response('ok', { status: 200 });
}

/* Called by the admin panel over a service binding, never over HTTP.

   Resend lives on this Worker, so rather than duplicating the API key into the
   panel's secrets, the panel asks this Worker to send. An RPC entrypoint has no
   URL at all, so this adds no public surface to defend. */
export class Mailer extends WorkerEntrypoint {
  async sendConfirmLink({ to, name, link, bins, weeks, startDate, dueDate, totalCents }) {
    if (!to || !link) return { ok: false, error: 'missing recipient or link' };

    const weeksText = weeks === 1 ? '1 week' : `${weeks} weeks`;
    const total = totalCents == null ? '' : `$${(totalCents / 100).toFixed(totalCents % 100 ? 2 : 0)}`;
    const day = iso => {
      const d = new Date(`${iso}T12:00:00`);
      return isNaN(d) ? iso : d.toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric' });
    };

    const text = `Hi ${name || 'there'},

Good news — we've got bins available for you.

  ${bins} bins · ${weeksText}
  Delivered ${day(startDate)}
  Back by ${day(dueDate)}
  ${total} plus tax

One link finishes everything — your delivery address, the rental agreement, and payment:

${link}

Nothing's booked until that's done, so the sooner the better if your dates matter.

Questions? Just reply to this email.

Beehive Bin Co.
support@beehivebin.co`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        reply_to: INBOX,
        subject: `Confirm your bin rental — ${bins} bins, ${day(startDate)}`,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.log('confirm link send failed', res.status, detail);
      return { ok: false, error: `Resend returned ${res.status}` };
    }
    return { ok: true };
  }

  /* The dates moved. Short, because the only question in the reader's head
     is "when are they coming now?" — and answered in the first line. */
  async sendRescheduled({ to, name, bins, weeks, startDate, dueDate, previousStart, reason }) {
    if (!to) return { ok: false, error: 'missing recipient' };
    const day = iso => {
      const d = new Date(`${iso}T12:00:00`);
      return isNaN(d) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    };
    const text = `Hi ${name || 'there'},

Your bin delivery has moved to ${day(startDate)} (it was ${day(previousStart)}).
${reason ? `\n${reason}\n` : ''}
  ${bins} bins · ${weeks === 1 ? '1 week' : `${weeks} weeks`}
  Delivered ${day(startDate)}
  Back by ${day(dueDate)}

Everything else about your rental stays the same. If that date doesn't work, reply to this email and we'll sort it out.

Beehive Bin Co.
support@beehivebin.co`;

    return sendEmail(this.env, { to, subject: `Your bin delivery is now ${day(startDate)}`, text });
  }

  /* The day before. Two sentences the reader needs, then the address, so a
     wrong one gets caught while there is still time. */
  async sendReminder({ to, name, job, date, bins, window, address, dueDate }) {
    if (!to) return { ok: false, error: 'missing recipient' };
    const day = iso => {
      const d = new Date(`${iso}T12:00:00`);
      return isNaN(d) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    };
    const when = window ? `between ${window}` : 'in the evening';
    const text = job === 'deliver'
      ? `Hi ${name || 'there'},

Your ${bins} bins arrive tomorrow, ${day(date)}, ${when}.

We'll leave them by the front door at:

  ${address || '(no address on file — please reply with one)'}

You don't need to be home. They're yours until ${day(dueDate)}.

If anything about that is wrong, reply to this email today.

Beehive Bin Co.
support@beehivebin.co`
      : `Hi ${name || 'there'},

We're collecting your ${bins} bins tomorrow, ${day(date)}, ${when}.

Please have them emptied, stacked, and by the front door at:

  ${address || '(the address we delivered to)'}

You don't need to be home. If you need them longer, reply to this email today and we'll add a week.

Thanks for using us,
Beehive Bin Co.
support@beehivebin.co`;

    return sendEmail(this.env, {
      to,
      subject: job === 'deliver' ? `Your bins arrive tomorrow ${when}` : `We're collecting your bins tomorrow ${when}`,
      text,
    });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/square/webhook') {
      return handleSquareWebhook(request, env);
    }

    // The customer-facing confirmation flow answers on its own hostname, so a
    // link in a customer's inbox reads as the business rather than as an API.
    if (url.hostname === env.BOOKING_HOST) return handleConfirm(request, env, url);

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
    if (data.form === 'reserve') {
      const problem = await reserveProblem(env, data);
      if (problem) return json({ ok: false, error: problem }, 400, origin);
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
