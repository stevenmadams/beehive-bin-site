/* The customer's confirmation page: one link, three steps.

   Served on book.beehivebin.co by the public Worker, because the customer has
   no Cloudflare Access session and never should. The link's only credential is
   the token in its path, so that token is the thing protecting a customer's
   address and agreement — it is generated with crypto.randomUUID and is never
   guessable, but it is also never shown anywhere except the email we send. */

import { AGREEMENT_HTML, AGREEMENT_TEXT, AGREEMENT_VERSION } from './agreement.js';
import { sendEmail, INBOX } from './mail.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = c => (c == null ? '—' : '$' + (c / 100).toLocaleString('en-US',
  { minimumFractionDigits: c % 100 ? 2 : 0 }));

const niceDate = iso => {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

const page = (title, inner, extraHead = '') => new Response(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — Beehive Bin Co.</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Archivo+Black&display=swap" rel="stylesheet">
<style>
:root{--yellow:#FFC400;--yellow-deep:#E3A800;--ink:#15130F;--paper:#F2F1EB;--white:#fff;
  --muted:#6B675C;--line:rgba(21,19,15,.14);--ok:#1F7A4C;--bad:#A32C2C;
  --font-display:"Archivo Black","Archivo","Arial Black",system-ui,sans-serif;
  --font-body:"Archivo",Inter,system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font-body);background:var(--paper);color:var(--ink);
  font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--font-display);font-weight:400;letter-spacing:-.02em;line-height:1.1;margin:0}
.wrap{max-width:660px;margin:0 auto;padding:28px 20px 80px}
/* Matches .site-header in assets/site.css — a customer arriving from an email
   should not wonder whether this is the same company. */
.site-header{background:var(--ink);color:#fff;border-bottom:3px solid var(--yellow)}
.site-header .bar{max-width:660px;margin-inline:auto;padding:0 20px;
  display:flex;align-items:center;gap:28px;height:66px}
.logo{display:flex;align-items:center;gap:11px;text-decoration:none;color:#fff}
.logo svg{width:30px;height:30px;flex:none}
.logo .name{font-family:var(--font-display);font-size:17px;letter-spacing:.02em;line-height:1}
.logo .tag{display:block;font-family:var(--font-body);font-weight:600;font-size:10px;
  letter-spacing:.08em;color:var(--yellow);text-transform:uppercase;margin-top:3px}
h1{font-size:clamp(28px,5vw,38px);margin-bottom:8px}
.sub{color:var(--muted);margin:0 0 26px}
.card{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:20px}
.card h2{font-size:19px;margin-bottom:14px}
.stepnum{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;
  background:var(--yellow);color:var(--ink);font-size:13px;font-weight:700;margin-right:9px;
  font-family:var(--font-body);vertical-align:2px}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;margin:0}
dt{color:var(--muted);font-size:14px}
dd{margin:0;font-weight:600}
label.fl{display:block;font-size:12px;font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;color:var(--muted);margin:16px 0 6px}
input,textarea{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:10px;
  background:var(--white);font:inherit;color:inherit}
textarea{min-height:80px;resize:vertical}
input:focus,textarea:focus{outline:2px solid var(--yellow);outline-offset:1px}
.help{display:block;color:var(--muted);font-size:13.5px;margin-top:6px}
.agreement{max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;background:#FBFAF6;font-size:14.5px}
.agreement h3{font-family:var(--font-body);font-weight:700;font-size:15px;margin:18px 0 7px}
.agreement h3:first-child{margin-top:0}
.agreement ul{padding-left:20px;margin:8px 0}
.agreement li{margin-bottom:6px}
.accept{display:flex;gap:11px;align-items:flex-start;margin-top:18px;
  background:rgba(255,196,0,.12);border:1px solid rgba(227,168,0,.4);border-radius:10px;padding:14px}
.accept input{width:19px;height:19px;flex:none;margin-top:2px}
.accept span{font-size:14.5px}
.btn{display:inline-block;border:1px solid var(--yellow-deep);background:var(--yellow);
  color:var(--ink);padding:15px 28px;border-radius:11px;font-weight:700;font-size:17px;
  cursor:pointer;text-decoration:none;font-family:inherit}
.btn:hover{background:var(--yellow-deep)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.banner{border-radius:10px;padding:13px 16px;margin-bottom:18px;font-weight:500}
.banner.err{background:rgba(163,44,44,.09);border:1px solid rgba(163,44,44,.28);color:#7A2020}
.banner.ok{background:rgba(31,122,76,.1);border:1px solid rgba(31,122,76,.3);color:var(--ok)}
.done{text-align:center;padding:20px 0}
.done .tick{width:56px;height:56px;border-radius:50%;background:var(--ok);color:#fff;
  display:grid;place-items:center;font-size:30px;margin:0 auto 16px}
footer{color:var(--muted);font-size:13.5px;text-align:center;padding:0 20px 40px}
footer a{color:inherit}
</style>${extraHead}</head>
<body>
<header class="site-header"><div class="bar">
<span class="logo">
<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 1.5 29 9v14L16 30.5 3 23V9z" fill="#FFC400" stroke="#15130F" stroke-width="2"/><path d="M10.5 13h11l-1.2 8.5h-8.6z" fill="#15130F"/><rect x="9" y="10.6" width="14" height="2.6" fill="#15130F"/></svg>
<span class="name">BEEHIVE BIN CO.<span class="tag">Move Better. Skip the Cardboard.</span></span>
</span></div></header>
<div class="wrap">${inner}</div>
<footer>Questions? <a href="mailto:support@beehivebin.co">support@beehivebin.co</a></footer>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

const notFound = () => page('Not found', `
  <h1>This link isn&rsquo;t valid</h1>
  <p class="sub">It may have expired, or been mistyped. Reply to the email we sent
  and we&rsquo;ll send a fresh one.</p>`);

/* Already signed and paid — nothing left to do but reassure them. */
const allDone = r => page('You&rsquo;re all set', `
  <div class="card done">
    <div class="tick">&check;</div>
    <h1>You&rsquo;re all set, ${esc(r.first_name || 'there')}</h1>
    <p class="sub">${esc(r.bins)} bins arriving <strong>${esc(niceDate(r.start_date))}</strong>,
    back by <strong>${esc(niceDate(r.due_date))}</strong>.</p>
    <p style="color:var(--muted);font-size:14.5px">We&rsquo;ll confirm your delivery window
    closer to the day. Nothing else is needed from you.</p>
  </div>`);

/* The customer's copy of what they signed.

   Sent at the moment of signing rather than on request, because the question
   this answers — "show me what I agreed to" — is always asked later, under
   pressure, by someone who no longer trusts us to produce it fairly. An email
   in their own inbox is theirs, not ours. */
async function emailSignedCopy(env, r, name, signedAt) {
  const when = new Date(signedAt).toLocaleString('en-US', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Denver',
  });
  const weeksText = r.weeks === 1 ? '1 week' : `${r.weeks} weeks`;
  const total = r.total_cents == null ? '—'
    : `$${(r.total_cents / 100).toFixed(r.total_cents % 100 ? 2 : 0)}`;

  const summary = [
    ['Signed by', name],
    ['Signed on', `${when} (Mountain Time)`],
    ['Agreement version', AGREEMENT_VERSION],
    ['Package', `${r.bins} bins · ${weeksText}`],
    ['Delivery', niceDate(r.start_date)],
    ['Return', niceDate(r.due_date)],
    ['Total', `${total} plus tax`],
  ];

  const text = `Hi ${r.first_name || 'there'},

Here's your copy of the rental agreement you just signed. Keep this email —
it's your record of exactly what you agreed to.

${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}

Questions about any of it? Just reply to this email.

────────────────────────────────────────
RENTAL AGREEMENT (version ${AGREEMENT_VERSION})
────────────────────────────────────────

${AGREEMENT_TEXT}

────────────────────────────────────────
Beehive Bin Co. · ${INBOX}`;

  const html = `<!doctype html><html><body style="margin:0;background:#F2F1EB;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
    color:#15130F;line-height:1.55">
    <div style="max-width:640px;margin:0 auto;padding:24px 20px 48px">
      <div style="background:#15130F;color:#fff;border-bottom:3px solid #FFC400;
        padding:18px 20px;border-radius:12px 12px 0 0">
        <strong style="font-size:16px;letter-spacing:.02em">BEEHIVE BIN CO.</strong>
      </div>
      <div style="background:#fff;padding:24px 22px;border:1px solid rgba(21,19,15,.14);border-top:0">
        <p style="margin-top:0">Hi ${esc(r.first_name || 'there')},</p>
        <p>Here's your copy of the rental agreement you just signed. Keep this email
        &mdash; it's your record of exactly what you agreed to.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14.5px">
          ${summary.map(([k, v]) => `<tr>
            <td style="padding:7px 0;color:#6B675C;width:150px">${esc(k)}</td>
            <td style="padding:7px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}
        </table>
        <p style="font-size:14.5px;color:#6B675C">Questions about any of it? Just reply to this email.</p>
        <hr style="border:0;border-top:1px solid rgba(21,19,15,.14);margin:26px 0">
        <p style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6B675C;
          font-weight:700;margin-bottom:14px">Rental agreement &middot; version ${esc(AGREEMENT_VERSION)}</p>
        <div style="font-size:14px">${AGREEMENT_HTML}</div>
      </div>
    </div></body></html>`;

  return sendEmail(env, {
    to: r.email,
    subject: `Your signed rental agreement — ${r.bins} bins, ${niceDate(r.start_date)}`,
    text,
    html,
  });
}

export async function handleConfirm(request, env, url) {
  const token = url.pathname.split('/').filter(Boolean)[0] || '';
  if (!/^[a-f0-9-]{20,60}$/i.test(token)) return notFound();

  const r = await env.DB.prepare(
    `SELECT id, status, first_name, last_name, email, phone, bins, weeks,
            start_date, due_date, total_cents, delivery_city, pickup_city,
            delivery_address, pickup_address, notes,
            agreement_signed_at, agreement_name, paid_at,
            square_invoice_url, square_status
     FROM rentals WHERE confirm_token = ?1`,
  ).bind(token).first();

  if (!r) return notFound();
  if (r.status === 'cancelled') return notFound();

  if (request.method === 'POST') return accept(request, env, r, token);

  if (r.agreement_signed_at && r.paid_at) return allDone(r);

  // Signed but unpaid: skip straight to the money, don't make them sign twice.
  if (r.agreement_signed_at) return payStep(r);

  return formStep(r);
}

const details = r => `
  <div class="card">
    <h2>Your rental</h2>
    <dl>
      <dt>Package</dt><dd>${esc(r.bins)} bins &middot; ${r.weeks === 1 ? '1 week' : `${esc(r.weeks)} weeks`}</dd>
      <dt>Delivered</dt><dd>${esc(niceDate(r.start_date))}</dd>
      <dt>Picked up</dt><dd>${esc(niceDate(r.due_date))}</dd>
      <dt>Total</dt><dd>${esc(money(r.total_cents))} <span style="font-weight:400;color:var(--muted)">plus tax</span></dd>
    </dl>
    <p class="help" style="margin-top:14px">Deliveries and pickups happen in the evening &mdash;
    we&rsquo;ll confirm your window closer to the day. Something wrong here?
    <a href="mailto:support@beehivebin.co">Tell us</a> before you sign.</p>
  </div>`;

const formStep = r => page('Confirm your rental', `
  <h1>Confirm your rental</h1>
  <p class="sub">Three quick steps and you&rsquo;re booked, ${esc(r.first_name || 'there')}.</p>
  ${details(r)}
  <form method="POST" id="f">
    <div class="card">
      <h2><span class="stepnum">1</span>Where are we going?</h2>
      <label class="fl" for="daddr">Delivery address &mdash; ${esc(r.delivery_city || '')}</label>
      <input id="daddr" name="delivery_address" required autocomplete="street-address"
        placeholder="Street address, apartment or unit"
        value="${esc(r.delivery_address || '')}">
      <label class="fl" for="paddr">Pickup address</label>
      <input id="paddr" name="pickup_address" autocomplete="street-address"
        placeholder="Leave blank if it&rsquo;s the same address"
        value="${esc(r.pickup_address || '')}">
      <label class="fl" for="notes">Anything we should know?</label>
      <textarea id="notes" name="notes" placeholder="Stairs, gate codes, parking, where to leave them&hellip;">${esc(r.notes || '')}</textarea>
      <span class="help">Gate codes and stair counts save everyone a phone call on the day.</span>
    </div>

    <div class="card">
      <h2><span class="stepnum">2</span>Rental agreement</h2>
      <div class="agreement">${AGREEMENT_HTML}</div>
      <label class="fl" for="signature">Type your full name to sign</label>
      <input id="signature" name="agreement_name" required autocomplete="name"
        placeholder="${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}">
      <label class="accept">
        <input type="checkbox" name="accept" value="yes" required>
        <span>I&rsquo;ve read and agree to the rental agreement above, including keeping a
        card on file and the charges described in Section 4.</span>
      </label>
    </div>

    <div class="card">
      <h2><span class="stepnum">3</span>Payment</h2>
      <p style="margin-top:0;color:var(--muted)">Sign above and we&rsquo;ll take you
      straight to secure payment through Square. ${esc(money(r.total_cents))} plus tax.</p>
      <button class="btn" type="submit" id="go">Sign and continue to payment</button>
    </div>
  </form>
  <script>
  document.getElementById('f').addEventListener('submit', () => {
    const b = document.getElementById('go');
    b.disabled = true; b.textContent = 'One moment\\u2026';
  });
  </script>`);

const payStep = r => page('Payment', `
  <h1>One step left</h1>
  <p class="sub">Signed and saved, ${esc(r.first_name || 'there')} &mdash; just payment now.</p>
  ${details(r)}
  <div class="card">
    <h2><span class="stepnum">3</span>Payment</h2>
    ${r.square_invoice_url
      ? `<p style="margin-top:0;color:var(--muted)">Secure payment is handled by Square.</p>
         <a class="btn" href="${esc(r.square_invoice_url)}">Pay ${esc(money(r.total_cents))} plus tax</a>`
      : `<div class="banner err">Your invoice isn&rsquo;t ready yet. We&rsquo;ll email it
         shortly &mdash; nothing else is needed from you right now.</div>`}
  </div>`);

async function accept(request, env, r, token) {
  const form = await request.formData().catch(() => null);
  if (!form) return page('Something went wrong', '<div class="banner err">We couldn&rsquo;t read that form. Please try again.</div>');

  const name = String(form.get('agreement_name') || '').trim().slice(0, 120);
  const daddr = String(form.get('delivery_address') || '').trim().slice(0, 300);

  if (!form.get('accept') || !name || !daddr) {
    return page('Confirm your rental', `
      <div class="banner err">Please add a delivery address, type your name, and tick the box to agree.</div>
      <p><a href="/${esc(token)}">Go back</a></p>`);
  }

  // Signing is once and for all: if a second submission arrives (a double-tap,
  // a stale tab, a forwarded link), keep the original signature record.
  if (!r.agreement_signed_at) {
    await env.DB.prepare(
      `UPDATE rentals SET delivery_address=?1, pickup_address=?2, notes=?3,
         agreement_signed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         agreement_name=?4, agreement_ip=?5, agreement_ua=?6, agreement_version=?7,
         status = CASE WHEN paid_at IS NOT NULL THEN 'confirmed' ELSE status END
       WHERE id=?8 AND agreement_signed_at IS NULL`,
    ).bind(
      daddr,
      String(form.get('pickup_address') || '').trim().slice(0, 300) || null,
      String(form.get('notes') || '').trim().slice(0, 2000) || null,
      name,
      request.headers.get('cf-connecting-ip') || null,
      (request.headers.get('user-agent') || '').slice(0, 400) || null,
      AGREEMENT_VERSION,
      r.id,
    ).run();

    await env.DB.prepare(
      'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
    ).bind(r.email || 'customer', 'rental.agreement_signed', 'rental', String(r.id),
           `${name} · ${AGREEMENT_VERSION}`).run();

    // Their copy. A failure here must not block them reaching payment — the
    // signature is already recorded — but it is logged so it can be resent.
    if (r.email) {
      const sent = await emailSignedCopy(env, r, name, new Date().toISOString())
        .catch(err => ({ ok: false, error: err.message }));
      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind('system', sent.ok ? 'rental.signed_copy_sent' : 'rental.signed_copy_failed',
             'rental', String(r.id), sent.ok ? r.email : (sent.error || 'unknown')).run();
    }
  } else {
    // Already signed, but let them correct where the bins go. Worth recording:
    // an address that changes the day before delivery makes the run sheet wrong,
    // and nobody would otherwise know it moved.
    const moved = daddr && daddr !== (r.delivery_address || '');
    await env.DB.prepare(
      'UPDATE rentals SET delivery_address=?1, pickup_address=?2, notes=?3 WHERE id=?4',
    ).bind(daddr,
      String(form.get('pickup_address') || '').trim().slice(0, 300) || null,
      String(form.get('notes') || '').trim().slice(0, 2000) || null, r.id).run();

    if (moved) {
      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind(r.email || 'customer', 'rental.address_changed', 'rental', String(r.id),
             `${r.delivery_address || '(blank)'} → ${daddr}`).run();
    }
  }

  const fresh = await env.DB.prepare(
    `SELECT id, first_name, bins, weeks, start_date, due_date, total_cents,
            square_invoice_url, agreement_signed_at, paid_at
     FROM rentals WHERE id = ?1`,
  ).bind(r.id).first();

  if (fresh.paid_at) return allDone(fresh);
  return payStep(fresh);
}
