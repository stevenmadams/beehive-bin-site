/* The customer's confirmation page: one link, three steps.

   Served on book.beehivebin.co by the public Worker, because the customer has
   no Cloudflare Access session and never should. The link's only credential is
   the token in its path, so that token is the thing protecting a customer's
   address and agreement — it is generated with crypto.randomUUID and is never
   guessable, but it is also never shown anywhere except the email we send. */

import { AGREEMENT_HTML, AGREEMENT_TEXT, AGREEMENT_VERSION, renderAgreement } from './agreement.js';
import { sendEmail, INBOX } from './mail.js';
import { SERVICE_CITIES, canonicalCity } from './service-area.js';
import { rateFor } from './tax.js';

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

/* Names are compared loosely on purpose. "Bob" for "Robert", a married name, a
   dropped middle name and an accent typed without it are all the same person;
   rejecting them would strand someone at 9pm with no way to finish. What the
   check is for is catching a name with no relationship to the rental at all —
   which is either a mistake or somebody else signing, and both should be
   deliberate rather than silent. */
const normalizeName = n => String(n || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
  .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

function nameLooksRight(typed, first, last) {
  const t = normalizeName(typed);
  if (t.length < 3 || !t.includes(' ') && !last) return !!t;

  const parts = new Set(t.split(' ').filter(w => w.length > 1));
  const f = normalizeName(first), l = normalizeName(last);

  // A surname match is the strong signal; a first-name match is enough when we
  // have no surname on file.
  if (l && parts.has(l)) return true;
  if (!l && f && parts.has(f)) return true;
  if (f && l && t === `${f} ${l}`) return true;
  return false;
}

/* The per-rental values the agreement text needs. Kept in one place so the page
   and the emailed copy can never show different terms for the same rental. */
/* The real number, not "plus tax".

   We know the delivery city and the date, so we know the rate — telling someone
   "$129 plus tax" when we could tell them $138.61 just makes them work it out
   or, worse, be surprised at the charge. Falls back to the vague form only if a
   rate genuinely cannot be found, which the booking form should prevent. */
function totals(r) {
  const sub = r.total_cents || 0;
  try {
    const { rate } = rateFor(r.delivery_city, r.start_date);
    const tax = Math.round(sub * parseFloat(rate) / 100);
    return { sub, tax, total: sub + tax, rate, known: true };
  } catch {
    return { sub, tax: 0, total: sub, rate: null, known: false };
  }
}

const totalLabel = r => {
  const t = totals(r);
  return t.known ? money(t.total) : `${money(t.sub)} plus tax`;
};

const agreementValues = r => ({
  BINS: r.bins,
  START_DATE: niceDate(r.start_date),
  RETURN_DATE: niceDate(r.due_date),
});

const page = (title, inner, extraHead = '', status = 200) => new Response(`<!doctype html>
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
.progress{display:flex;gap:8px;margin:0 0 24px;list-style:none;padding:0}
.progress li{flex:1;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:var(--muted);padding-top:9px;border-top:3px solid var(--line)}
.progress li[data-state="now"]{color:var(--ink);border-top-color:var(--yellow)}
.progress li[data-state="done"]{color:var(--ok);border-top-color:var(--ok)}
.backlink{display:inline-block;font-size:13.5px;color:var(--muted);margin-top:14px}
.recap{background:#FBFAF6;border:1px solid var(--line);border-radius:10px;padding:13px 15px;
  margin-bottom:18px;font-size:14.5px}
.recap strong{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);margin-bottom:5px;font-weight:700}
.frow2{display:grid;grid-template-columns:1fr 110px;gap:12px}
@media (max-width:420px){.frow2{grid-template-columns:1fr}}
.same{display:flex;gap:10px;align-items:center;margin:16px 0 4px;font-size:15px}
.same input{width:19px;height:19px;flex:none}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;margin:0}
dt{color:var(--muted);font-size:14px}
dd{margin:0;font-weight:600}
label.fl{display:block;font-size:12px;font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;color:var(--muted);margin:16px 0 6px}
input,textarea,select{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:10px;
  background:var(--white);font:inherit;color:inherit}
textarea{min-height:80px;resize:vertical}
input:focus,textarea:focus,select:focus{outline:2px solid var(--yellow);outline-offset:1px}
.help{display:block;color:var(--muted);font-size:13.5px;margin-top:6px}
/* Shown in full, never in a scrolling window. Terms someone has to hunt through
   a 340px box to read are terms they can fairly say they were not shown. */
.agreement{border:1px solid var(--line);border-radius:10px;
  padding:20px 22px;background:#FBFAF6;font-size:15px;line-height:1.6}
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
</body></html>`, { status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const notFound = () => page('Not found', `
  <h1>This link isn&rsquo;t valid</h1>
  <p class="sub">It may have expired, or been mistyped. Reply to the email we sent
  and we&rsquo;ll send a fresh one.</p>`, '', 404);

/* Cancelled is not "not found". The customer had this link in their inbox;
   telling them it is invalid sends them looking for a typo. */
const cancelled = r => page('This rental was cancelled', `
  <h1>This rental was cancelled</h1>
  <p class="sub">There&rsquo;s nothing to do here${r.paid_at ? ' &mdash; if a refund is due, it goes back to the card you paid with' : ''}.
  If that&rsquo;s a surprise, reply to the email we sent or write to
  <a href="mailto:support@beehivebin.co">support@beehivebin.co</a> and we&rsquo;ll sort it out.</p>`, '', 410);

/* Already signed and paid — nothing left to do but reassure them. */
const allDone = r => page('You&rsquo;re all set', `
  <div class="card done">
    <div class="tick">&check;</div>
    <h1>You&rsquo;re all set, ${esc(r.first_name || 'there')}</h1>
    <p class="sub">${esc(r.bins)} bins arriving <strong>${esc(niceDate(r.start_date))}</strong>,
    back by <strong>${esc(niceDate(r.due_date))}</strong>. Paid ${esc(totalLabel(r))}.</p>
    <p style="color:var(--muted);font-size:14.5px">${r.delivery_window
      ? `Delivery is <strong>${esc(r.delivery_window)}</strong>; pickup <strong>${esc(r.pickup_window || r.delivery_window)}</strong>. We&rsquo;ll email you the day before each.`
      : 'We&rsquo;ll confirm your delivery window closer to the day.'} Nothing else is needed from you.</p>
    ${r.square_invoice_url ? `<a class="btn" href="${esc(r.square_invoice_url)}">View your receipt</a>` : ''}
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

${renderAgreement(AGREEMENT_TEXT, agreementValues(r))}

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
        <div style="font-size:14px">${renderAgreement(AGREEMENT_HTML, agreementValues(r))}</div>
      </div>
    </div></body></html>`;

  return sendEmail(env, {
    to: r.email,
    subject: `Your signed rental agreement — ${r.bins} bins, ${niceDate(r.start_date)}`,
    text,
    html,
  });
}

const STEPS = [['review', 'Your rental'], ['address', 'Where'],
  ['agreement', 'Agreement'], ['card', 'Card'], ['pay', 'Payment']];

/* Which step someone is on is derived from what has actually been saved, never
   from a URL or a hidden field. Refresh, close the tab, come back tomorrow from
   the same link — it resumes where they left off, and a half-finished form
   cannot claim to be further along than it is. */
const stepFor = r => {
  if (r.agreement_signed_at && r.paid_at) return 'done';
  // The agreement requires a card on file for the whole rental, so it is
  // collected before payment rather than hoped for during it.
  if (r.agreement_signed_at && !r.square_card_id) return 'card';
  if (r.agreement_signed_at) return 'pay';
  if (r.delivery_address) return 'agreement';
  if (r.details_confirmed_at) return 'address';
  return 'review';
};

const progress = current => {
  const order = STEPS.map(([id]) => id);
  const i = order.indexOf(current);
  return `<ol class="progress">${STEPS.map(([id, label], n) => {
    const state = n < i ? 'done' : n === i ? 'now' : 'todo';
    return `<li data-state="${state}">${n + 1}. ${label}</li>`;
  }).join('')}</ol>`;
};

/* Shown on the first step and again at payment, so the closing line has to
   change: "tell us before you sign" is nonsense on a page you reach by signing. */
const details = (r, opts = {}) => `
  <div class="card">
    <h2>Your rental</h2>
    <dl>
      <dt>Package</dt><dd>${esc(r.bins)} bins &middot; ${r.weeks === 1 ? '1 week' : `${esc(r.weeks)} weeks`}</dd>
      <dt>Delivered</dt><dd>${esc(niceDate(r.start_date))}</dd>
      <dt>Picked up</dt><dd>${esc(niceDate(r.due_date))}</dd>
      ${(() => { const t = totals(r); return t.known ? `
        <dt>Rental</dt><dd>${esc(money(t.sub))}</dd>
        <dt>Utah sales tax</dt><dd>${esc(money(t.tax))} <span style="font-weight:400;color:var(--muted)">(${esc(t.rate)}% in ${esc(r.delivery_city)})</span></dd>
        <dt>Total</dt><dd style="font-size:18px">${esc(money(t.total))}</dd>`
        : `<dt>Total</dt><dd>${esc(money(t.sub))} <span style="font-weight:400;color:var(--muted)">plus tax</span></dd>`; })()}
    </dl>
    <p class="help" style="margin-top:14px">Deliveries and pickups happen in the evening &mdash;
    we&rsquo;ll confirm your window closer to the day. ${opts.beforeSigning
      ? 'Something wrong here? <a href="mailto:support@beehivebin.co">Tell us</a> before you sign.'
      : 'Something not right? <a href="mailto:support@beehivebin.co">Get in touch</a> and we&rsquo;ll sort it out.'}</p>
  </div>`;

/* One line is not enough. A free-text address could contradict the city the
   booking was taken for — Bountiful selected, an Ogden street typed — and the
   invoice would be taxed at the wrong rate. It also cannot be formatted for a
   run sheet or sorted by area. State is omitted: everywhere we serve is Utah. */
const addressFields = (kind, r) => {
  const v = f => esc(r[`${kind}_${f}`] || '');
  const city = kind === 'delivery' ? r.delivery_city : r.pickup_city;
  return `
    <label class="fl" for="${kind}-street">Street address</label>
    <input id="${kind}-street" name="${kind}_street" required autocomplete="address-line1"
      placeholder="e.g. 412 N Sycamore Ave" value="${v('street')}">

    <label class="fl" for="${kind}-unit">Apartment or unit <span style="text-transform:none;letter-spacing:0;font-weight:400">(optional)</span></label>
    <input id="${kind}-unit" name="${kind}_unit" autocomplete="address-line2"
      placeholder="Apt 3B, Unit 214&hellip;" value="${v('unit')}">

    <div class="frow2">
      <div>
        <label class="fl" for="${kind}-city">City</label>
        <select id="${kind}-city" name="${kind}_city" required>
          <option value="">Choose&hellip;</option>
          ${SERVICE_CITIES.map(c => `<option value="${esc(c)}"${
            city === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="fl" for="${kind}-zip">ZIP</label>
        <input id="${kind}-zip" name="${kind}_zip" required inputmode="numeric"
          pattern="[0-9]{5}" maxlength="5" placeholder="84037" value="${v('zip')}">
      </div>
    </div>`;
};

/* Step 1 — check we got it right before anything is asked of them. Cheaper to
   fix a wrong date here than after a signature, and it is the moment they agree
   these are the terms being signed for. */
const reviewStep = r => page('Your rental', `
  <h1>Confirm your rental</h1>
  <p class="sub">Four quick steps and you&rsquo;re booked, ${esc(r.first_name || 'there')}.</p>
  ${progress('review')}
  ${details(r, { beforeSigning: true })}
  <form method="POST">
    <input type="hidden" name="step" value="review">
    <button class="btn" type="submit">That&rsquo;s right &mdash; continue</button>
  </form>`);

/* Step 2 — where the bins go, and where they come back from. These are two
   different visits: dropped at a house, collected from a storage unit across
   town is entirely normal, and one set of instructions made the second visit
   guess. */
const addressStep = r => page('Where are we going?', `
  <h1>Where are we going?</h1>
  <p class="sub">Where we drop the bins off, and where we collect them from.</p>
  ${progress('address')}
  <form method="POST">
    <input type="hidden" name="step" value="address">
    <div class="card">
      <h2>Delivery</h2>
      ${addressFields('delivery', r)}
      <label class="fl" for="dnotes">Anything we should know?</label>
      <textarea id="dnotes" name="delivery_notes"
        placeholder="Stairs, gate code, parking, where to leave them&hellip;">${esc(r.delivery_notes || '')}</textarea>
      <span class="help">Gate codes and stair counts save everyone a phone call on the day.</span>
    </div>

    <div class="card">
      <h2>Pickup</h2>
      <label class="same">
        <input type="checkbox" name="same" value="yes" id="same"
          ${!r.pickup_address || r.pickup_address === r.delivery_address ? 'checked' : ''}>
        <span>Pick up from the same address</span>
      </label>
      <span class="help" style="margin:0 0 4px 30px">Untick this if we&rsquo;re collecting from somewhere else.</span>
      <div id="pickupfields">
        ${addressFields('pickup', r)}
        <span class="help">City not listed? We can&rsquo;t collect from there &mdash;
        <a href="mailto:support@beehivebin.co">email us</a> and we&rsquo;ll sort something out.</span>
        <label class="fl" for="pnotes">Anything different about the pickup?</label>
        <textarea id="pnotes" name="pickup_notes"
          placeholder="Different gate code, storage unit number, a different contact&hellip;">${esc(r.pickup_notes || '')}</textarea>
      </div>
      <span class="help">Moving out of one place and into another? Tell us both.</span>
    </div>

    <button class="btn" type="submit">Continue to the agreement</button>
  </form>
  <script>
  // Hiding the pickup block is a convenience; the server treats a ticked box as
  // "same address" regardless, so this failing changes nothing.
  (() => {
    const same = document.getElementById('same');
    const box = document.getElementById('pickupfields');
    const sync = () => {
      box.hidden = same.checked;
      /* Disable as well as hide. A required field that is hidden still blocks
         submission, and the browser cannot show an error on a control it cannot
         display — so the button appears to do nothing at all. Disabled controls
         are skipped by validation and left out of the post, which is what we
         want: the server copies the delivery address when "same" is ticked. */
      box.querySelectorAll('input, select, textarea').forEach(el => {
        el.disabled = same.checked;
      });
    };
    same.addEventListener('change', sync);
    sync();
  })();
  </script>`);

const addressRecap = r => `
  <div class="recap">
    <strong>Delivering to</strong>
    ${esc(r.delivery_address || '')}${r.delivery_notes ? `<br><span style="color:var(--muted)">${esc(r.delivery_notes)}</span>` : ''}
    ${r.pickup_address && r.pickup_address !== r.delivery_address
      ? `<div style="margin-top:10px"><strong>Collecting from</strong>${esc(r.pickup_address)}${
          r.pickup_notes ? `<br><span style="color:var(--muted)">${esc(r.pickup_notes)}</span>` : ''}</div>`
      : ''}
    <a class="backlink" href="?step=address">Change this</a>
  </div>`;

const agreementStep = (r, opts = {}) => page('Rental agreement', `
  <h1>Rental agreement</h1>
  <p class="sub">Have a read, then sign at the bottom.</p>
  ${progress('agreement')}
  ${addressRecap(r)}
  <form method="POST">
    <input type="hidden" name="step" value="agreement">
    <div class="card">
      <div class="agreement">${renderAgreement(AGREEMENT_HTML, agreementValues(r))}</div>
      ${opts.mismatch ? `<div class="banner err" style="margin-top:18px">
        This rental is in the name of <strong>${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}</strong>,
        but you&rsquo;ve typed <strong>${esc(opts.typed)}</strong>. If that was a typo, correct it below.
        If you&rsquo;re signing for them, tick the box and carry on.</div>` : ''}
      <label class="fl" for="signature">Type your full name to sign</label>
      <input id="signature" name="agreement_name" required autocomplete="name"
        value="${esc(opts.typed || '')}"
        placeholder="${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}">
      ${opts.mismatch ? `<label class="accept" style="background:var(--white)">
        <input type="checkbox" name="on_behalf" value="yes">
        <span>I&rsquo;m signing on behalf of ${esc([r.first_name, r.last_name].filter(Boolean).join(' '))},
        and I&rsquo;m authorised to agree to these terms for them.</span>
      </label>` : ''}
      <label class="accept">
        <input type="checkbox" name="accept" value="yes" required>
        <span>I&rsquo;ve read and agree to the rental agreement above, including keeping a
        card on file and the charges described in Section 4.</span>
      </label>
      <p class="help" style="margin-top:14px">We&rsquo;ll email you a copy of this
      agreement as soon as you sign.</p>
    </div>
    <button class="btn" type="submit">Sign and continue to payment</button>
  </form>`);

/* Step 4 — the card that §3 of the agreement requires.

   Square's Web Payments SDK renders the card fields in an iframe it controls
   and hands back a single-use token. The number never touches this page's
   JavaScript or our servers. Without this the agreement's authorisation to
   charge for late returns and damage had nothing behind it. */
const cardStep = (r, env, problem) => page('Card on file', `
  <h1>Card on file</h1>
  <p class="sub">One card, used for this rental and anything agreed afterwards.</p>
  ${progress('card')}
  ${problem ? `<div class="banner err">${esc(problem)}</div>` : ''}
  <div class="card">
    <p style="margin-top:0;color:var(--muted);font-size:14.5px">
      We keep your card on file for the length of the rental, as set out in the
      agreement you just signed. It covers this rental, any extra weeks you ask
      for, and the charges in Section&nbsp;4. We&rsquo;ll email a receipt for
      anything we charge.</p>
    <div id="card-container" style="margin:18px 0 6px"></div>
    <div id="card-error" class="banner err" hidden style="margin-top:12px"></div>
    ${(() => { const t = totals(r); return t.known ? `
      <div class="recap" style="margin:0 0 16px">
        <strong>What you&rsquo;ll be charged</strong>
        ${esc(money(t.sub))} rental + ${esc(money(t.tax))} Utah sales tax (${esc(t.rate)}%)
        = <strong style="display:inline;font-size:16px">${esc(money(t.total))}</strong>
      </div>` : ''; })()}
    <button class="btn" id="card-go" disabled>Save card and pay ${esc(totalLabel(r))}</button>
    <p class="help" style="margin-top:14px">Your card details go straight to Square.
    They never pass through our systems.</p>
  </div>

  <script src="${env.SQUARE_ENV === 'production'
    ? 'https://web.squarecdn.com/v1/square.js'
    : 'https://sandbox.web.squarecdn.com/v1/square.js'}"></script>
  <script>
  (async () => {
    const btn = document.getElementById('card-go');
    const errBox = document.getElementById('card-error');
    const fail = m => { errBox.hidden = false; errBox.textContent = m; };

    if (!window.Square) { fail('Card payment could not load. Please refresh, or reply to our email and we will take it another way.'); return; }

    let card;
    try {
      const payments = window.Square.payments(${JSON.stringify(env.SQUARE_APP_ID || '')}, ${JSON.stringify(env.SQUARE_LOCATION_ID || '')});
      card = await payments.card();
      await card.attach('#card-container');
      btn.disabled = false;
    } catch (e) {
      fail('Card payment could not start. Please refresh and try again.');
      return;
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Saving\u2026';
      errBox.hidden = true;
      try {
        const result = await card.tokenize();
        if (result.status !== 'OK') {
          throw new Error((result.errors && result.errors[0] && result.errors[0].message) || 'That card was not accepted.');
        }
        const res = await fetch(location.pathname + '/card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: result.token }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error || 'That card could not be saved.');
        location.href = location.pathname;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = was;
        fail(e.message || 'That card could not be saved.');
      }
    });
  })();
  </script>`);

const payStep = r => page('Payment', `
  <h1>One step left</h1>
  <p class="sub">Signed and saved, ${esc(r.first_name || 'there')} &mdash; just payment now.</p>
  ${progress('pay')}
  ${details(r)}
  <div class="card">
    <h2>Payment</h2>
    ${r.square_card_id
      /* No link to Square while a charge is pending. That URL is a payment form
         — card fields, wallets, a "save my card" box — and handing it to someone
         whose card is already being charged invites them to pay twice. It only
         becomes a receipt once the invoice is settled. */
      ? `<p style="margin-top:0">We&rsquo;re charging your ${esc(r.card_brand || 'card')} ending
         <strong>${esc(r.card_last4 || '••••')}</strong> &mdash; <strong>${esc(totalLabel(r))}</strong>.</p>
         <p style="color:var(--muted);font-size:14.5px">Square emails your receipt once it goes
         through, usually within a minute. There&rsquo;s nothing else for you to do &mdash; and
         nothing to pay separately. If the card is declined we&rsquo;ll email you.</p>`
      : `<div class="banner err">Your invoice isn&rsquo;t ready yet. We&rsquo;ll email it
         shortly &mdash; nothing else is needed from you right now.</div>`}
  </div>
  ${addressRecap(r)}`);

const COLUMNS = `id, confirm_token, status, details_confirmed_at, signed_on_behalf,
  square_card_id, card_brand, card_last4,
  delivery_street, delivery_unit, delivery_zip, pickup_street, pickup_unit, pickup_zip, first_name, last_name, email, phone, bins, weeks,
  start_date, due_date, total_cents, delivery_city, pickup_city,
  delivery_address, pickup_address, delivery_notes, pickup_notes,
  agreement_signed_at, agreement_name, paid_at, square_invoice_url, square_status,
  delivery_window, pickup_window`;

const load = (env, token) => env.DB.prepare(
  `SELECT ${COLUMNS} FROM rentals WHERE confirm_token = ?1`).bind(token).first();

export async function handleConfirm(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const token = parts[0] || '';
  if (!/^[a-f0-9-]{20,60}$/i.test(token)) return notFound();

  let r = await load(env, token);
  if (!r) return notFound();
  if (r.status === 'cancelled') return cancelled(r);

  /* The card submission is JSON from the SDK, not a form post, and it charges
     the rental as soon as the card is stored. */
  if (request.method === 'POST' && url.pathname.endsWith('/card')) {
    const body = await request.json().catch(() => null);
    if (!body?.sourceId) return json({ ok: false, error: 'no card token' }, 400);
    if (!r.agreement_signed_at) return json({ ok: false, error: 'sign the agreement first' }, 409);
    // Paid is paid. A stale tab or a double-tap must not store a second card
    // or ask for a second charge — the answer is simply "done".
    if (r.paid_at) return json({ ok: true, already: true });

    const stored = await env.BILLING.storeCardForRental(token, body);
    if (!stored?.ok) return json({ ok: false, error: stored?.error || 'That card could not be saved.' }, 400);

    // Charging is a separate call so a stored card survives a payment failure —
    // the agreement's authorisation is what we most need to keep.
    const charged = await env.BILLING.chargeRental(token);
    if (!charged?.ok) {
      console.log('charge after card store failed:', charged?.error);
    }
    return json({ ok: true });
  }

  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    if (!form) return notFound();

    const step = String(form.get('step') || '');

    /* Each step is only accepted once the ones before it are done. The pages
       enforce this by what they show; the handler enforces it by what it
       saves, because a form post is just a request and can say anything. A
       signature with no address behind it would be an agreement to deliver
       nowhere. */
    const order = STEPS.map(([id]) => id);
    if (order.indexOf(step) > order.indexOf(stepFor(r))) {
      return new Response(null, { status: 303, headers: { Location: `/${token}` } });
    }

    const problem = step === 'review' ? await confirmDetails(env, r)
      : step === 'address' ? await saveAddress(env, r, form)
      : step === 'agreement' ? await saveSignature(request, env, r, form)
      : 'Something went wrong. Please try again.';

    // A name mismatch is a question, not a failure: send them back to the form
    // with what they typed and the option to say they are signing for someone.
    if (problem && problem.mismatch) return agreementStep(r, problem);
    if (problem) return retry(r, step, problem);

    // Redirect after a write: a refresh should never re-submit a signature, and
    // the step to show is derived from what was just saved anyway.
    return new Response(null, { status: 303, headers: { Location: `/${token}` } });
  }

  const at = stepFor(r);
  if (at === 'done') return allDone(r);

  // Going back to fix something is allowed; skipping ahead is not.
  const back = url.searchParams.get('step');
  if (back === 'address' && at !== 'done') return addressStep(r);
  if (back === 'review' && at !== 'done') return reviewStep(r);

  return at === 'review' ? reviewStep(r)
    : at === 'address' ? addressStep(r)
    : at === 'agreement' ? agreementStep(r)
    : at === 'card' ? cardStep(r, env)
    : payStep(r);
}

const retry = (r, step, problem) => page('Check that again', `
  <h1>Almost there</h1>
  <div class="banner err">${esc(problem)}</div>
  <p class="sub">Nothing was lost &mdash; go back and it will still be filled in.</p>
  <p><a class="btn" href="/${esc(r.confirm_token)}${step === 'address' ? '?step=address' : ''}">Go back</a></p>`);

async function confirmDetails(env, r) {
  if (r.details_confirmed_at) return null;
  await env.DB.prepare(
    "UPDATE rentals SET details_confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
  ).bind(r.id).run();
  return null;
}

/* Compose the one-line form the panel and run sheet display, from the parts. */
const composeAddress = a =>
  [a.street, a.unit, `${a.city} UT ${a.zip}`.trim()].filter(Boolean).join(', ');

function readAddress(form, kind) {
  const t = (f, n) => String(form.get(`${kind}_${f}`) || '').trim().slice(0, n);
  return {
    street: t('street', 200),
    unit: t('unit', 60) || null,
    city: canonicalCity(form.get(`${kind}_city`)),
    zip: t('zip', 10),
  };
}

const addressProblem = (a, label) => {
  if (!a.street) return `Please add the ${label} street address.`;
  if (!a.city) return `Please choose a ${label} city from the list. If yours is not there, email support@beehivebin.co and we will sort something out.`;
  if (!/^\d{5}$/.test(a.zip)) return `Please add a five-digit ${label} ZIP code.`;
  return null;
};

async function saveAddress(env, r, form) {
  const d = readAddress(form, 'delivery');
  const dProblem = addressProblem(d, 'delivery');
  if (dProblem) return dProblem;

  const same = !!form.get('same');
  const p = same ? { ...d } : readAddress(form, 'pickup');
  if (!same) {
    const pProblem = addressProblem(p, 'pickup');
    if (pProblem) return pProblem;
  }

  await env.DB.prepare(
    `UPDATE rentals SET
       delivery_street=?1, delivery_unit=?2, delivery_city=?3, delivery_zip=?4, delivery_address=?5,
       pickup_street=?6,  pickup_unit=?7,  pickup_city=?8,  pickup_zip=?9,  pickup_address=?10,
       delivery_notes=?11, pickup_notes=?12
     WHERE id=?13`,
  ).bind(
    d.street, d.unit, d.city, d.zip, composeAddress(d),
    p.street, p.unit, p.city, p.zip, composeAddress(p),
    String(form.get('delivery_notes') || '').trim().slice(0, 2000) || null,
    same ? null : String(form.get('pickup_notes') || '').trim().slice(0, 2000) || null,
    r.id,
  ).run();

  const daddr = composeAddress(d);

  // Worth a line once they have signed: an address that moves the day before
  // delivery silently invalidates the run sheet, and nobody would otherwise know.
  if (r.agreement_signed_at && daddr !== (r.delivery_address || '')) {
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
    ).bind(r.email || 'customer', 'rental.address_changed', 'rental', String(r.id),
           `${r.delivery_address || '(blank)'} → ${daddr}`).run();
  }
  return null;
}

async function saveSignature(request, env, r, form) {
  const name = String(form.get('agreement_name') || '').trim().slice(0, 120);
  if (!form.get('accept') || !name) return 'Please type your name and tick the box to agree.';

  const onBehalf = !!form.get('on_behalf');
  if (!onBehalf && !nameLooksRight(name, r.first_name, r.last_name)) {
    return { mismatch: true, typed: name };
  }

  // Signing happens once. A stale tab, a double-tap or a forwarded link must not
  // overwrite who signed or when.
  if (r.agreement_signed_at) return null;

  await env.DB.prepare(
    `UPDATE rentals SET agreement_signed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       agreement_name=?1, agreement_ip=?2, agreement_ua=?3, agreement_version=?4,
       status = CASE WHEN paid_at IS NOT NULL THEN 'confirmed' ELSE status END
     WHERE id=?5 AND agreement_signed_at IS NULL`,
  ).bind(
    name,
    request.headers.get('cf-connecting-ip') || null,
    (request.headers.get('user-agent') || '').slice(0, 400) || null,
    AGREEMENT_VERSION,
    r.id,
  ).run();

  if (onBehalf) {
    await env.DB.prepare('UPDATE rentals SET signed_on_behalf = 1 WHERE id = ?1').bind(r.id).run();
  }

  await env.DB.prepare(
    'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
  ).bind(r.email || 'customer', 'rental.agreement_signed', 'rental', String(r.id),
         `${name}${onBehalf ? ' (on behalf)' : ''} · ${AGREEMENT_VERSION}`).run();

  if (r.email) {
    const sent = await emailSignedCopy(env, r, name, new Date().toISOString())
      .catch(err => ({ ok: false, error: err.message }));
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
    ).bind('system', sent.ok ? 'rental.signed_copy_sent' : 'rental.signed_copy_failed',
           'rental', String(r.id), sent.ok ? r.email : (sent.error || 'unknown')).run();
  }
  return null;
}

