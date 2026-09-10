/* Beehive Bin Co. — admin backend (admin.beehivebin.co).

   Cloudflare Access proves who the visitor is; this Worker decides what they
   may do and serves the panel. Static files come from ./public; everything
   under /api is handled here. */

import { verifyAccessJwt } from './auth.js';
import { createInvoice, fetchInvoice, ping as squarePing, SquareError } from './square.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- identity + authorization ---------- */

/* Local development only. Running the panel on your laptop means there is no
   Access proxy to mint a JWT, so `wrangler dev --var ACCESS_DEV_EMAIL:you@beehivebin.co`
   stands in for one.

   Double-locked: the var must be set *and* the request must not have come
   through Cloudflare's edge. Every request that reaches the deployed Worker
   carries a `cf-ray` header set by the edge itself, and admin.beehivebin.co is
   reachable no other way (workers_dev is off), so a copy of the var left in
   wrangler.toml by accident still cannot open a hole in production.

   Hostname is deliberately not the signal here: `wrangler dev` reports the
   configured custom domain as the request host, so a loopback check fails
   locally for a reason that has nothing to do with security. */
function devEmail(request, env) {
  if (!env.ACCESS_DEV_EMAIL) return null;
  if (request.headers.get('cf-ray')) {
    console.log('ACCESS_DEV_EMAIL ignored: request came through the Cloudflare edge');
    return null;
  }
  return String(env.ACCESS_DEV_EMAIL).trim().toLowerCase();
}

/* Access has already verified the email address itself. The employees table
   decides whether that verified person is staff here. An @beehivebin.co
   mailbox is trusted implicitly and enrolled on first sign-in, so a mistake in
   the Employees tab can never lock everyone out of the panel. */
async function authenticate(request, env) {
  let email = devEmail(request, env);

  if (!email) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new HttpError(401, 'No Access token. Reach this panel through admin.beehivebin.co.');
    try {
      email = await verifyAccessJwt(token, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
      });
    } catch (err) {
      console.log('access verify failed:', err.message);
      throw new HttpError(401, 'Sign-in could not be verified.');
    }
  }

  const domain = String(env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
  const onDomain = !!domain && email.endsWith(`@${domain}`);

  let row = await env.DB.prepare(
    'SELECT id, email, name, role, active FROM employees WHERE email = ?1',
  ).bind(email).first();

  if (!row) {
    if (!onDomain) throw new HttpError(403, `${email} is not on the staff list.`);
    // First person through the door owns the place.
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM employees WHERE role = ?1 AND active = 1',
    ).bind('owner').first();
    const role = count > 0 ? 'staff' : 'owner';
    await env.DB.prepare(
      'INSERT INTO employees (email, name, role, created_by) VALUES (?1, ?2, ?3, ?4)',
    ).bind(email, email.split('@')[0], role, 'auto-enrolled').run();
    await audit(env, email, 'employee.auto_enroll', 'employee', email, `role=${role}`);
    row = await env.DB.prepare(
      'SELECT id, email, name, role, active FROM employees WHERE email = ?1',
    ).bind(email).first();
  }

  // A revoked employee who still holds a domain mailbox stays revoked: the
  // Employees tab is the authority, not the mail server.
  if (!row.active) throw new HttpError(403, `Access for ${email} has been revoked.`);

  await env.DB.prepare(
    "UPDATE employees SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
  ).bind(row.id).run();

  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

const requireOwner = user => {
  if (user.role !== 'owner') throw new HttpError(403, 'Only an owner can change the staff list.');
};

const audit = (env, actor, action, entity, entityId, detail = null) =>
  env.DB.prepare(
    'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
  ).bind(actor, action, entity, String(entityId), detail).run();

/* ---------- request handlers ---------- */

const REQUEST_COLUMNS = `id, created_at, kind, source, status, contact_pref, first_name, last_name, email, phone,
  bins, weeks, start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
  customer_notes, message, internal_notes, decided_at, decided_by, decline_reason`;

const STATUSES = ['new', 'approved', 'declined', 'converted'];

async function listRequests(env, url) {
  const status = url.searchParams.get('status');
  const q = String(url.searchParams.get('q') || '').trim();
  const where = [];
  const binds = [];

  if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'unknown status');
    binds.push(status);
    where.push(`status = ?${binds.length}`);
  }
  if (q) {
    binds.push(`%${q.toLowerCase()}%`);
    const p = `?${binds.length}`;
    where.push(`(lower(first_name || ' ' || coalesce(last_name,'')) LIKE ${p}
      OR lower(coalesce(email,'')) LIKE ${p}
      OR replace(replace(replace(coalesce(phone,''),'-',''),' ',''),'.','') LIKE ${p}
      OR lower(coalesce(delivery_city,'')) LIKE ${p})`);
  }

  const sql = `SELECT ${REQUEST_COLUMNS} FROM requests
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT 200`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}

/* Package pricing, in cents. Must stay in sync with the PRICES/EXTRA tables in
   reserve.html until the Settings tab owns pricing for both. */
const PRICES = { 10: 3900, 20: 7900, 40: 12900, 60: 17900 };
const EXTRA  = { 10: 2500, 20: 4000, 40: 6500, 60: 9000 };
const quoteCents = (bins, weeks) =>
  PRICES[bins] == null ? null : PRICES[bins] + (weeks - 1) * EXTRA[bins];

const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
const addWeeks = (iso, weeks) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
};
const clean = (v, max) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, max) : null;
};

/* A request typed in by staff — someone who phoned instead of using the site.
   Same shape as a web submission so every downstream view treats them alike;
   `source` is what tells them apart. The quote is computed here rather than
   accepted from the client, so a stale or edited panel cannot invent a price. */
async function createRequest(env, user, body) {
  const kind = body.kind === 'contact' ? 'contact' : 'reserve';
  const first = clean(body.first_name, 100);
  const pref = ['text', 'call', 'email'].includes(body.contact_pref) ? body.contact_pref : null;
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 200);

  if (!first) throw new HttpError(400, 'A first name is required.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'That email address looks wrong.');
  }

  let bins = null, weeks = null, start = null, returnDate = null, quoted = null, dcity = null;

  if (kind === 'reserve') {
    bins = parseInt(body.bins, 10);
    weeks = parseInt(body.weeks, 10);
    start = isoDate(body.start_date);
    dcity = clean(body.delivery_city, 120);

    if (!PRICES[bins]) throw new HttpError(400, 'Pick a package: 10, 20, 40 or 60 bins.');
    if (!Number.isFinite(weeks) || weeks < 1 || weeks > 26) throw new HttpError(400, 'Weeks must be between 1 and 26.');
    if (!start) throw new HttpError(400, 'A start date is required.');
    if (!dcity) throw new HttpError(400, 'A delivery city is required.');
    if (!phone && !email) throw new HttpError(400, 'A phone number or email is required.');

    returnDate = addWeeks(start, weeks);
    // An override exists because phone-in customers are exactly where custom
    // pricing happens; blank means use the standard package rate.
    const override = String(body.quoted_total ?? '').trim();
    if (override) {
      const m = /([\d,]+(?:\.\d{1,2})?)/.exec(override);
      if (!m) throw new HttpError(400, 'That quoted total is not a number.');
      quoted = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
    } else {
      quoted = quoteCents(bins, weeks);
    }
  } else {
    start = isoDate(body.start_date);
    dcity = clean(body.delivery_city, 120);
    if (!phone && !email) throw new HttpError(400, 'A phone number or email is required.');
  }

  const res = await env.DB.prepare(
    `INSERT INTO requests (kind, source, first_name, last_name, email, phone, bins, weeks,
       start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
       customer_notes, message, internal_notes, contact_pref, raw_json)
     VALUES (?1,'manual',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
  ).bind(
    kind, first, clean(body.last_name, 100), email, phone, bins, weeks,
    start, returnDate, quoted, dcity, clean(body.pickup_city, 120),
    clean(body.customer_notes, 4000), clean(body.message, 4000),
    clean(body.internal_notes, 4000), pref,
    JSON.stringify({ entered_by: user.email }),
  ).run();

  const id = res.meta.last_row_id;
  await audit(env, user.email, 'request.create', 'request', id, `source=manual kind=${kind}`);
  return env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?1`).bind(id).first();
}

async function decideRequest(env, user, id, body) {
  const action = body.action;
  if (!['approve', 'decline', 'reopen'].includes(action)) throw new HttpError(400, 'unknown action');

  const existing = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?1`)
    .bind(id).first();
  if (!existing) throw new HttpError(404, 'no such request');

  // Approving is the moment the job becomes real, so it produces the rental
  // record the schedule and run sheet are built from.
  let rentalId = null;
  if (action === 'approve') {
    const already = await env.DB.prepare('SELECT id FROM rentals WHERE request_id = ?1')
      .bind(id).first();
    rentalId = already ? already.id : await createRentalFromRequest(env, user, existing);
  }

  const status = action === 'approve' ? 'converted' : action === 'decline' ? 'declined' : 'new';
  const reason = action === 'decline' ? String(body.reason || '').trim().slice(0, 500) || null : null;
  const decidedAt = action === 'reopen' ? null : new Date().toISOString().replace(/\.\d+/, '');
  const decidedBy = action === 'reopen' ? null : user.email;

  await env.DB.prepare(
    'UPDATE requests SET status = ?1, decided_at = ?2, decided_by = ?3, decline_reason = ?4 WHERE id = ?5',
  ).bind(status, decidedAt, decidedBy, reason, id).run();
  await audit(env, user.email, `request.${action}`, 'request', id, reason);

  const request = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?1`)
    .bind(id).first();
  return { request, rental_id: rentalId };
}

async function addEmployee(env, user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 100);
  const role = body.role === 'owner' ? 'owner' : 'staff';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That email address looks wrong.');

  const existing = await env.DB.prepare('SELECT id, active FROM employees WHERE email = ?1')
    .bind(email).first();
  if (existing) {
    // Re-inviting someone previously revoked should just restore them.
    if (existing.active) throw new HttpError(409, `${email} is already on the staff list.`);
    await env.DB.prepare('UPDATE employees SET active = 1, role = ?1, name = ?2 WHERE id = ?3')
      .bind(role, name || email.split('@')[0], existing.id).run();
    await audit(env, user.email, 'employee.restore', 'employee', email, `role=${role}`);
  } else {
    await env.DB.prepare(
      'INSERT INTO employees (email, name, role, created_by) VALUES (?1,?2,?3,?4)',
    ).bind(email, name || email.split('@')[0], role, user.email).run();
    await audit(env, user.email, 'employee.add', 'employee', email, `role=${role}`);
  }
  return env.DB.prepare('SELECT id, email, name, role, active, created_at, last_seen_at FROM employees WHERE email = ?1')
    .bind(email).first();
}

async function updateEmployee(env, user, id, body) {
  const row = await env.DB.prepare('SELECT id, email, role, active FROM employees WHERE id = ?1')
    .bind(id).first();
  if (!row) throw new HttpError(404, 'no such employee');

  const active = 'active' in body ? (body.active ? 1 : 0) : row.active;
  const role = body.role === 'owner' ? 'owner' : body.role === 'staff' ? 'staff' : row.role;

  if (row.email === user.email && (!active || role !== 'owner')) {
    throw new HttpError(400, 'You cannot revoke or demote your own account.');
  }
  // Losing the last owner would leave nobody able to manage staff.
  if (row.role === 'owner' && (role !== 'owner' || !active)) {
    const { count } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM employees WHERE role = 'owner' AND active = 1 AND id != ?1",
    ).bind(id).first();
    if (count === 0) throw new HttpError(400, 'This is the last owner — promote someone else first.');
  }

  const name = 'name' in body ? String(body.name || '').trim().slice(0, 100) : null;
  await env.DB.prepare(
    'UPDATE employees SET active = ?1, role = ?2, name = coalesce(?3, name) WHERE id = ?4',
  ).bind(active, role, name, id).run();
  await audit(env, user.email, 'employee.update', 'employee', row.email, `active=${active} role=${role}`);

  return env.DB.prepare('SELECT id, email, name, role, active, created_at, last_seen_at FROM employees WHERE id = ?1')
    .bind(id).first();
}

/* ---------- rentals ---------- */

const RENTAL_COLUMNS = `id, request_id, created_at, created_by, status,
  confirm_token, confirm_sent_at, agreement_name, agreement_version, agreement_signed_at AS signed_at,
  square_customer_id, square_order_id, square_invoice_id, square_invoice_url, square_status,
  first_name, last_name, email, phone, contact_pref,
  bins, weeks, start_date, due_date, total_cents,
  delivery_city, delivery_address, delivery_notes, pickup_city, pickup_address, pickup_notes,
  agreement_signed_at, paid_at, delivered_at, returned_at, notes`;

const RENTAL_STATUSES = ['pending', 'confirmed', 'out', 'returned', 'cancelled'];
const now = () => new Date().toISOString().replace(/\.\d+/, '');

/* Status is derived from the milestone timestamps so the two can never
   disagree — except `cancelled`, which is a decision rather than an event and
   therefore sticks until someone un-cancels. */
function statusFrom(r) {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.returned_at) return 'returned';
  if (r.delivered_at) return 'out';
  if (r.agreement_signed_at && r.paid_at) return 'confirmed';
  return 'pending';
}

/* Turning a request into a rental copies the agreed terms across. If the
   request never had a start date or package (a contact-form enquiry), there is
   nothing to schedule and it should not become a rental. */
async function createRentalFromRequest(env, user, req) {
  if (req.kind !== 'reserve') {
    throw new HttpError(400, 'Only a reservation can become a rental. Take the details first with + New request.');
  }
  if (!req.bins || !req.weeks || !req.start_date) {
    throw new HttpError(400, 'This request is missing a package, length or start date.');
  }

  const due = addWeeks(req.start_date, req.weeks);
  const res = await env.DB.prepare(
    `INSERT INTO rentals (request_id, created_by, first_name, last_name, email, phone,
       contact_pref, bins, weeks, start_date, due_date, total_cents,
       delivery_city, pickup_city)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  ).bind(
    req.id, user.email, req.first_name, req.last_name, req.email, req.phone,
    req.contact_pref, req.bins, req.weeks, req.start_date, due, req.quoted_total_cents,
    req.delivery_city, req.pickup_city || req.delivery_city,
  ).run();

  const id = res.meta.last_row_id;
  await audit(env, user.email, 'rental.create', 'rental', id, `from request ${req.id}`);
  return id;
}

async function listRentals(env, url) {
  const status = url.searchParams.get('status') || 'active';
  const binds = [];
  let where = '';

  if (status === 'active') {
    // What someone actually needs on a Monday: everything not finished.
    where = "WHERE status IN ('pending','confirmed','out')";
  } else if (status !== 'all') {
    if (!RENTAL_STATUSES.includes(status)) throw new HttpError(400, 'unknown status');
    binds.push(status);
    where = 'WHERE status = ?1';
  }

  const { results } = await env.DB.prepare(
    `SELECT ${RENTAL_COLUMNS} FROM rentals ${where}
     ORDER BY start_date, id LIMIT 300`,
  ).bind(...binds).all();
  return results;
}

const MILESTONES = {
  agreement: 'agreement_signed_at',
  paid: 'paid_at',
  delivered: 'delivered_at',
  returned: 'returned_at',
};

/* Milestones toggle rather than only set, because the commonest correction is
   marking the wrong rental delivered and needing to undo it immediately. */
async function updateRental(env, user, id, body) {
  const row = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!row) throw new HttpError(404, 'no such rental');

  const patch = { ...row };

  if (body.milestone) {
    const col = MILESTONES[body.milestone];
    if (!col) throw new HttpError(400, 'unknown milestone');
    // Square is the authority on money. Once it reports the invoice paid, the
    // panel cannot contradict it — a UI that hides the button is not enough,
    // since anything can call this endpoint.
    if (body.milestone === 'paid' && body.done === false && row.square_status === 'PAID') {
      throw new HttpError(409, 'Square has this invoice as paid. Refund it in Square if that is wrong.');
    }
    patch[col] = body.done === false ? null : now();

    if (body.milestone === 'delivered' && patch.delivered_at) {
      if (!patch.paid_at && !body.force) {
        // Not fatal — sometimes you deliver on trust — but it should be deliberate.
        throw new HttpError(409, 'This rental is not paid yet. Mark it delivered anyway?');
      }
      const why = await requirePhoto(env, id, 'delivery', body.photo_reason);
      if (why) await audit(env, user.email, 'rental.delivered_no_photo', 'rental', id, why);
    }

    if (body.milestone === 'returned' && patch.returned_at) {
      const why = await requirePhoto(env, id, 'pickup', body.photo_reason);
      if (why) await audit(env, user.email, 'rental.returned_no_photo', 'rental', id, why);
    }
  }

  for (const f of ['delivery_address', 'pickup_address', 'delivery_city', 'pickup_city']) {
    if (f in body) patch[f] = clean(body[f], 500);
  }
  if ('status' in body) {
    if (!RENTAL_STATUSES.includes(body.status)) throw new HttpError(400, 'unknown status');
    patch.status = body.status;
  }

  patch.status = statusFrom(patch);

  await env.DB.prepare(
    `UPDATE rentals SET status=?1, agreement_signed_at=?2, paid_at=?3, delivered_at=?4,
       returned_at=?5, delivery_address=?6, pickup_address=?7, delivery_city=?8,
       pickup_city=?9, notes=?10 WHERE id=?11`,
  ).bind(
    patch.status, patch.agreement_signed_at, patch.paid_at, patch.delivered_at,
    patch.returned_at, patch.delivery_address, patch.pickup_address,
    patch.delivery_city, patch.pickup_city, patch.notes, id,
  ).run();

  await audit(env, user.email, body.milestone ? `rental.${body.milestone}` : 'rental.update',
    'rental', id, body.milestone ? `done=${body.done !== false}` : null);

  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* Raising the invoice is explicit rather than automatic on approval: the owner
   may want to adjust the address or the price first, and an invoice already
   emailed to a customer is awkward to retract. */
async function invoiceRental(env, user, id) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (rental.square_invoice_id) {
    throw new HttpError(409, 'This rental already has an invoice.');
  }
  if (rental.status === 'cancelled') throw new HttpError(400, 'This rental is cancelled.');

  let sq;
  try {
    sq = await createInvoice(env, rental);
  } catch (err) {
    if (err instanceof SquareError) throw new HttpError(err.status === 503 ? 503 : 400, err.message);
    throw err;
  }

  // The customer link and the invoice are minted together, because the link is
  // useless without something to pay and the invoice is unreachable without it.
  const token = rental.confirm_token || crypto.randomUUID();

  await env.DB.prepare(
    `UPDATE rentals SET square_customer_id=?1, square_order_id=?2, square_invoice_id=?3,
       square_invoice_url=?4, square_status=?5, confirm_token=?6 WHERE id=?7`,
  ).bind(sq.square_customer_id, sq.square_order_id, sq.square_invoice_id,
         sq.square_invoice_url, sq.square_status, token, id).run();

  await audit(env, user.email, 'rental.invoice', 'rental', id, sq.square_invoice_id);
  await sendConfirmLink(env, user, id);
  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* The customer always gets this by email — the agreement and payment are the
   record of the deal, and an email is what they can find again in six months.
   Their contact preference governs informal chasing, not the paperwork. */
async function sendConfirmLink(env, user, id) {
  const r = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!r) throw new HttpError(404, 'no such rental');
  if (!r.confirm_token) throw new HttpError(400, 'Create the invoice first — the link needs something to pay.');
  if (!r.email) throw new HttpError(400, 'This rental has no email address to send to.');

  const res = await env.MAILER.sendConfirmLink({
    to: r.email,
    name: r.first_name,
    link: `https://${env.BOOKING_HOST}/${r.confirm_token}`,
    bins: r.bins,
    weeks: r.weeks,
    startDate: r.start_date,
    dueDate: r.due_date,
    totalCents: r.total_cents,
  });

  // A failure here is not fatal to the invoice, which already exists — but the
  // owner must know the customer never heard about it.
  if (!res?.ok) throw new HttpError(502, `The invoice was created, but the email failed to send (${res?.error || 'unknown'}). Try Resend link.`);

  await env.DB.prepare("UPDATE rentals SET confirm_sent_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1")
    .bind(id).run();
  await audit(env, user.email, 'rental.confirm_sent', 'rental', id, r.email);
}

/* Manual reconciliation for when a webhook was missed — Square is the source of
   truth for whether money arrived, never the panel. */
async function syncRental(env, user, id) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (!rental.square_invoice_id) throw new HttpError(400, 'This rental has no Square invoice.');

  let invoice;
  try {
    invoice = await fetchInvoice(env, rental.square_invoice_id);
  } catch (err) {
    if (err instanceof SquareError) throw new HttpError(err.status === 503 ? 503 : 400, err.message);
    throw err;
  }

  const paidAt = invoice.status === 'PAID' ? (rental.paid_at || now()) : rental.paid_at;
  await env.DB.prepare('UPDATE rentals SET square_status=?1, paid_at=?2 WHERE id=?3')
    .bind(invoice.status, paidAt, id).run();
  await env.DB.prepare('UPDATE rentals SET status=?1 WHERE id=?2')
    .bind(statusFrom({ ...rental, paid_at: paidAt }), id).run();

  await audit(env, user.email, 'rental.sync', 'rental', id, invoice.status);
  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* ---------- internal notes ----------

   Append-only, attributed, and never shown to a customer — the public Worker
   does not read this table at all. */

const ENTITIES = ['request', 'rental'];

async function listNotes(env, entity, entityId) {
  if (!ENTITIES.includes(entity)) throw new HttpError(400, 'unknown entity');
  const { results } = await env.DB.prepare(
    `SELECT id, body, author, created_at, pinned, deleted_at, deleted_by
     FROM internal_notes WHERE entity = ?1 AND entity_id = ?2
     ORDER BY pinned DESC, created_at DESC LIMIT 200`,
  ).bind(entity, entityId).all();
  return results;
}

async function addNote(env, user, entity, entityId, body) {
  if (!ENTITIES.includes(entity)) throw new HttpError(400, 'unknown entity');
  const text = String(body.body ?? '').trim().slice(0, 4000);
  if (!text) throw new HttpError(400, 'A note needs something in it.');

  const table = entity === 'request' ? 'requests' : 'rentals';
  const exists = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?1`)
    .bind(entityId).first();
  if (!exists) throw new HttpError(404, `no such ${entity}`);

  await env.DB.prepare(
    'INSERT INTO internal_notes (entity, entity_id, body, author, pinned) VALUES (?1,?2,?3,?4,?5)',
  ).bind(entity, entityId, text, user.email, body.pinned ? 1 : 0).run();
  await audit(env, user.email, 'note.add', entity, entityId);
  return listNotes(env, entity, entityId);
}

/* Deleting marks rather than removes, and only your own — the point of an
   attributed log is that it cannot be quietly tidied. Pinning is not restricted
   the same way: it changes prominence, not the record. */
async function updateNote(env, user, id, body) {
  const note = await env.DB.prepare(
    'SELECT id, entity, entity_id, author, deleted_at FROM internal_notes WHERE id = ?1',
  ).bind(id).first();
  if (!note) throw new HttpError(404, 'no such note');

  if ('deleted' in body) {
    if (note.author !== user.email && user.role !== 'owner') {
      throw new HttpError(403, 'You can only delete your own notes.');
    }
    await env.DB.prepare(
      `UPDATE internal_notes SET deleted_at = ?1, deleted_by = ?2 WHERE id = ?3`,
    ).bind(body.deleted ? now() : null, body.deleted ? user.email : null, id).run();
    await audit(env, user.email, body.deleted ? 'note.delete' : 'note.restore',
      note.entity, note.entity_id);
  }

  if ('pinned' in body) {
    await env.DB.prepare('UPDATE internal_notes SET pinned = ?1 WHERE id = ?2')
      .bind(body.pinned ? 1 : 0, id).run();
  }

  return listNotes(env, note.entity, note.entity_id);
}

/* ---------- photos ----------

   Taken on a phone at the door. The Worker streams the body straight into R2
   and records the key; nothing about the image passes through D1. */

const PHOTO_KINDS = ['delivery', 'pickup'];
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;   // comfortably above a phone photo
const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

async function listPhotos(env, rentalId) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, r2_key, content_type, bytes, taken_by, taken_at, caption, deleted_at
     FROM rental_photos WHERE rental_id = ?1 AND deleted_at IS NULL
     ORDER BY kind, taken_at DESC`,
  ).bind(rentalId).all();
  return results;
}

async function uploadPhoto(request, env, user, rentalId, url) {
  if (!env.PHOTOS) throw new HttpError(503, 'Photo storage is not connected yet (R2 is not enabled).');

  const kind = url.searchParams.get('kind');
  if (!PHOTO_KINDS.includes(kind)) throw new HttpError(400, 'Photo must be for delivery or pickup.');

  const rental = await env.DB.prepare('SELECT id FROM rentals WHERE id = ?1').bind(rentalId).first();
  if (!rental) throw new HttpError(404, 'no such rental');

  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE.includes(type)) throw new HttpError(400, `That file type (${type || 'unknown'}) is not an image we accept.`);

  const body = await request.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, 'That photo came through empty.');
  if (body.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large.');

  // Keyed by rental and kind so the bucket is browsable if anyone ever has to
  // go looking without the database.
  const key = `rentals/${rentalId}/${kind}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });

  await env.DB.prepare(
    `INSERT INTO rental_photos (rental_id, kind, r2_key, content_type, bytes, taken_by, caption)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(rentalId, kind, key, type, body.byteLength, user.email,
         (url.searchParams.get('caption') || '').slice(0, 300) || null).run();

  await audit(env, user.email, `rental.photo_${kind}`, 'rental', rentalId, `${Math.round(body.byteLength / 1024)}KB`);
  return listPhotos(env, rentalId);
}

/* Served through the Worker rather than from a public bucket URL: these are
   pictures of customers' homes, and Access already decides who may look. */
async function servePhoto(env, key) {
  if (!env.PHOTOS) throw new HttpError(503, 'Photo storage is not connected yet.');
  const row = await env.DB.prepare(
    'SELECT content_type FROM rental_photos WHERE r2_key = ?1 AND deleted_at IS NULL').bind(key).first();
  if (!row) throw new HttpError(404, 'no such photo');

  const obj = await env.PHOTOS.get(key);
  if (!obj) throw new HttpError(404, 'photo missing from storage');

  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type,
      // Private: an Access session got them here, and a shared cache must not
      // hand the image to the next person.
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function deletePhoto(env, user, id) {
  const row = await env.DB.prepare(
    'SELECT id, rental_id, r2_key, taken_by, deleted_at FROM rental_photos WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'no such photo');
  if (row.deleted_at) return listPhotos(env, row.rental_id);
  if (row.taken_by !== user.email && user.role !== 'owner') {
    throw new HttpError(403, 'You can only remove photos you took.');
  }

  // The object goes; the row stays, so the record shows a photo existed and who
  // removed it. A photo that can vanish without trace is not evidence.
  await env.PHOTOS?.delete(row.r2_key);
  await env.DB.prepare('UPDATE rental_photos SET deleted_at = ?1, deleted_by = ?2 WHERE id = ?3')
    .bind(now(), user.email, id).run();
  await audit(env, user.email, 'rental.photo_deleted', 'rental', row.rental_id);
  return listPhotos(env, row.rental_id);
}

/* Marking a visit done without its photo is allowed, because a flat battery at
   a basement door is a real thing — but it needs a reason, and the reason is
   recorded. Otherwise the habit quietly lapses on exactly the jobs where the
   evidence would have mattered. */
async function requirePhoto(env, rentalId, kind, reason) {
  const { count } = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM rental_photos WHERE rental_id = ?1 AND kind = ?2 AND deleted_at IS NULL',
  ).bind(rentalId, kind).first();
  if (count > 0) return null;
  if (!reason || !String(reason).trim()) {
    throw new HttpError(428, `No ${kind} photo yet. Add one, or give a reason to continue without it.`);
  }
  return String(reason).trim().slice(0, 300);
}

/* ---------- router ---------- */

async function api(request, env, url) {
  const user = await authenticate(request, env);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  // Some POSTs are pure commands with nothing to send (invoice, sync), so an
  // empty body is valid — only malformed JSON is an error.
  let body = {};
  const isUpload = method === 'POST' && /^\/rentals\/\d+\/photos$/.test(path);
  if (!isUpload && ['POST', 'PATCH', 'PUT'].includes(method)) {
    const raw = await request.text();
    if (raw.trim()) {
      try { body = JSON.parse(raw); }
      catch { throw new HttpError(400, 'bad JSON body'); }
    }
  }

  const match = re => re.exec(path);
  let m;

  if (path === '/me' && method === 'GET') return json({ user, booking_host: env.BOOKING_HOST });

  if (path === '/stats' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT status, COUNT(*) AS count FROM requests GROUP BY status',
    ).all();
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of results) counts[r.status] = r.count;

    const { count: activeRentals } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status IN ('pending','confirmed','out')",
    ).first();
    const { count: overdue } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status = 'out' AND due_date < date('now')",
    ).first();

    return json({ counts, rentals: { active: activeRentals, overdue } });
  }

  if (path === '/requests') {
    if (method === 'GET') return json({ requests: await listRequests(env, url) });
    if (method === 'POST') return json({ request: await createRequest(env, user, body) }, 201);
  }

  if ((m = match(/^\/requests\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const row = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS}, raw_json FROM requests WHERE id = ?1`)
        .bind(id).first();
      if (!row) throw new HttpError(404, 'no such request');
      return json({ request: row });
    }
    if (method === 'PATCH') {
      const notes = String(body.internal_notes ?? '').slice(0, 4000);
      const res = await env.DB.prepare('UPDATE requests SET internal_notes = ?1 WHERE id = ?2')
        .bind(notes, id).run();
      if (!res.meta.changes) throw new HttpError(404, 'no such request');
      await audit(env, user.email, 'request.note', 'request', id);
      return json({ ok: true });
    }
  }

  if ((m = match(/^\/requests\/(\d+)\/decision$/)) && method === 'POST') {
    return json(await decideRequest(env, user, Number(m[1]), body));
  }

  if (path === '/square/ping' && method === 'GET') {
    try {
      return json(await squarePing(env));
    } catch (err) {
      if (err instanceof SquareError) return json({ error: err.message, detail: err.detail }, err.status === 503 ? 503 : 400);
      throw err;
    }
  }

  if (path === '/rentals' && method === 'GET') {
    return json({ rentals: await listRentals(env, url) });
  }

  if ((m = match(/^\/rentals\/(\d+)$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') {
      const row = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
        .bind(rid).first();
      if (!row) throw new HttpError(404, 'no such rental');
      return json({ rental: row });
    }
    if (method === 'PATCH') return json({ rental: await updateRental(env, user, rid, body) });
  }

  if ((m = match(/^\/rentals\/(\d+)\/invoice$/)) && method === 'POST') {
    return json({ rental: await invoiceRental(env, user, Number(m[1])) });
  }
  if ((m = match(/^\/rentals\/(\d+)\/photos$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') return json({ photos: await listPhotos(env, rid) });
    if (method === 'POST') return json({ photos: await uploadPhoto(request, env, user, rid, url) }, 201);
  }

  if ((m = match(/^\/photos\/(\d+)$/)) && method === 'DELETE') {
    return json({ photos: await deletePhoto(env, user, Number(m[1])) });
  }

  if (path.startsWith('/photo/') && method === 'GET') {
    return servePhoto(env, decodeURIComponent(path.slice('/photo/'.length)));
  }

  if ((m = match(/^\/rentals\/(\d+)\/send$/)) && method === 'POST') {
    const rid = Number(m[1]);
    await sendConfirmLink(env, user, rid);
    return json({ rental: await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(rid).first() });
  }

  if ((m = match(/^\/rentals\/(\d+)\/sync$/)) && method === 'POST') {
    return json({ rental: await syncRental(env, user, Number(m[1])) });
  }

  if (path === '/employees') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, email, name, role, active, created_at, created_by, last_seen_at FROM employees ORDER BY active DESC, role, email',
      ).all();
      return json({ employees: results, domain: env.ALLOWED_EMAIL_DOMAIN });
    }
    if (method === 'POST') {
      requireOwner(user);
      return json({ employee: await addEmployee(env, user, body) }, 201);
    }
  }

  if ((m = match(/^\/employees\/(\d+)$/)) && method === 'PATCH') {
    requireOwner(user);
    return json({ employee: await updateEmployee(env, user, Number(m[1]), body) });
  }

  if ((m = match(/^\/(requests|rentals)\/(\d+)\/notes$/))) {
    const entity = m[1] === 'requests' ? 'request' : 'rental';
    const eid = Number(m[2]);
    if (method === 'GET') return json({ notes: await listNotes(env, entity, eid) });
    if (method === 'POST') return json({ notes: await addNote(env, user, entity, eid, body) }, 201);
  }

  if ((m = match(/^\/notes\/(\d+)$/)) && method === 'PATCH') {
    return json({ notes: await updateNote(env, user, Number(m[1]), body) });
  }

  if ((m = match(/^\/(requests|rentals)\/(\d+)\/history$/)) && method === 'GET') {
    const entity = m[1] === 'requests' ? 'request' : 'rental';
    const { results } = await env.DB.prepare(
      `SELECT at, actor_email, action, detail FROM audit_log
       WHERE entity = ?1 AND entity_id = ?2 ORDER BY at DESC, id DESC LIMIT 100`,
    ).bind(entity, m[2]).all();
    return json({ history: results });
  }

  if (path === '/audit' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT at, actor_email, action, entity, entity_id, detail FROM audit_log ORDER BY at DESC LIMIT 100',
    ).all();
    return json({ entries: results });
  }

  throw new HttpError(404, 'no such endpoint');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') return new Response('beehive-admin ok');

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.log('admin api error:', err.stack || err.message);
        return json({ error: 'Something broke on our end.' }, 500);
      }
    }

    // Everything else is the panel itself. Access already gated it at the edge.
    return env.ASSETS.fetch(request);
  },
};
