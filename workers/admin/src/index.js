/* Beehive Bin Co. — admin backend (admin.beehivebin.co).

   Cloudflare Access proves who the visitor is; this Worker decides what they
   may do and serves the panel. Static files come from ./public; everything
   under /api is handled here. */

import { verifyAccessJwt } from './auth.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createInvoice, fetchInvoice, ping as squarePing, storeCard, ensureCustomer, SquareError } from './square.js';
import { PRICES, EXTRA, quoteCents } from './pricing.js';
import { rateFor, serviceCity, SERVICE_CITIES } from './tax.js';
import { availability, canFit, getSettings, stoplights, blackoutOn } from './inventory.js';
import { today, addDays, addWeeks, isoDate, dayDiff, startOfDay } from '../../shared/clock.js';
import { coverage, claimSlot, isTime, closedDayName, closedWeekdays } from '../../shared/coverage.js';
import { HOLIDAYS, holidaysIn } from '../../shared/holidays.js';
import { customerFor, emailKey, phoneKey } from '../../shared/customers.js';
import { itemsOn, whereabouts, assign as assignBins, unassign as unassignBin, inspect as inspectBins, resolveRest, release as releaseBins } from './binlink.js';
import { listCharges, proposals, outstanding, owedCents } from './charges.js';

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
  // Under the same lock, a request may say who it is — so a test can be the
  // owner on one line and a staff member on the next.
  const asked = request.headers.get('x-dev-email');
  return String(asked || env.ACCESS_DEV_EMAIL).trim().toLowerCase();
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

/* Two roles. Staff do the evening run — photos, milestones, addresses,
   counting, notes, their own hours. Everything that moves money or makes a
   promise to a customer is an owner's: approving, sending the link,
   cancelling, moving dates, extending, charging. To delegate any of that,
   make the person an owner. */
const requireOwner = (user, what = 'do that') => {
  if (user.role !== 'owner') throw new HttpError(403, `Only an owner can ${what}.`);
};

const audit = (env, actor, action, entity, entityId, detail = null) =>
  env.DB.prepare(
    'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
  ).bind(actor, action, entity, String(entityId), detail).run();

/* ---------- request handlers ---------- */

/* The lapsed/stalled flags compare against the business day, which is
   worked out in JS (Mountain Time) and inlined. It is a YYYY-MM-DD produced by
   Intl, never user input, so a literal is safe — and binding it would mean
   threading a parameter through every query that names these columns. */
const REQUEST_COLUMNS = () => `id, created_at, kind, source, status, contact_pref,
  CASE WHEN status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')
       THEN 1 ELSE 0 END AS lapsed, first_name, last_name, email, phone,
  bins, weeks, start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
  customer_notes, message, internal_notes, decided_at, decided_by, decline_reason, customer_id,
  (SELECT id FROM rentals WHERE rentals.request_id = requests.id LIMIT 1) AS rental_id`;

const STATUSES = ['new', 'approved', 'declined', 'converted'];

async function listRequests(env, url) {
  // The list is the open questions. Everything else is on the customer.
  const status = url.searchParams.get('status') || 'new';
  const q = String(url.searchParams.get('q') || '').trim();
  const where = [];
  const binds = [];

  /* A request for a date that has passed is dead — the customer needed bins on
     the 25th and it is the 26th. It is still unhandled work, so it stays in the
     queue, but it must not read as live. Derived rather than stored: a date
     passing should not silently rewrite a record. */
  if (status === 'lapsed') {
    where.push(`status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')`);
  } else if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'unknown status');
    binds.push(status);
    where.push(`status = ?${binds.length}`);
    if (status === 'new') {
      where.push(`(start_date IS NULL OR date(start_date) >= date('${today()}'))`);
    }
  }
  if (q) {
    binds.push(`%${q.toLowerCase()}%`);
    const p = `?${binds.length}`;
    where.push(`(lower(first_name || ' ' || coalesce(last_name,'')) LIKE ${p}
      OR lower(coalesce(email,'')) LIKE ${p}
      OR replace(replace(replace(coalesce(phone,''),'-',''),' ',''),'.','') LIKE ${p}
      OR lower(coalesce(delivery_city,'')) LIKE ${p})`);
  }

  const sql = `SELECT ${REQUEST_COLUMNS()} FROM requests
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT 200`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}


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
    const dayOff = await closedDayName(env, start);
    if (dayOff) throw new HttpError(400, `We do not deliver on ${dayOff}s.`);
    const closed = await blackoutOn(env, start);
    if (closed) throw new HttpError(400, `We are not delivering on ${start} — ${closed}.`);
    if (!dcity) throw new HttpError(400, 'A delivery city is required.');
    // The city decides the tax rate and whether we go there at all. A typo
    // here becomes an invoice that cannot be raised three weeks from now.
    if (!serviceCity(dcity)) throw new HttpError(400, `We don't serve "${dcity}" — pick a city from the service area.`);
    dcity = serviceCity(dcity);
    if (body.pickup_city && !serviceCity(body.pickup_city)) {
      throw new HttpError(400, `We don't serve "${clean(body.pickup_city, 120)}" for pickup — pick a city from the service area.`);
    }
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
    start, returnDate, quoted, dcity, body.pickup_city ? serviceCity(body.pickup_city) : null,
    clean(body.customer_notes, 4000), clean(body.message, 4000),
    null, pref,
    JSON.stringify({ entered_by: user.email }),
  ).run();

  const id = res.meta.last_row_id;
  const customerId = await customerFor(env, { email, phone, first_name: first, last_name: clean(body.last_name, 100), city: dcity }, user.email);
  if (customerId) await env.DB.prepare('UPDATE requests SET customer_id = ?1 WHERE id = ?2').bind(customerId, id).run();
  await audit(env, user.email, 'request.create', 'request', id, `source=manual kind=${kind}`);

  // What was typed under "Internal notes" is a note — attributed, in the
  // notes list — not a column that nothing displays.
  const internal = clean(body.internal_notes, 4000);
  if (internal) await addNote(env, user, 'request', id, { body: internal });

  return env.DB.prepare(`SELECT ${REQUEST_COLUMNS()} FROM requests WHERE id = ?1`).bind(id).first();
}

async function decideRequest(env, user, id, body) {
  const action = body.action;
  if (!['approve', 'decline', 'reopen'].includes(action)) throw new HttpError(400, 'unknown action');

  const existing = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS()} FROM requests WHERE id = ?1`)
    .bind(id).first();
  if (!existing) throw new HttpError(404, 'no such request');

  // Approving is the moment the job becomes real, so it produces the rental
  // record the schedule and run sheet are built from.
  /* Reopening is for a decline that was wrong. A converted request has a
     rental behind it — sending it back to "new" would leave that rental
     orphaned and invite a second one. */
  if (action === 'reopen' && existing.status === 'converted') {
    const r = await env.DB.prepare('SELECT id FROM rentals WHERE request_id = ?1').bind(id).first();
    throw new HttpError(409, `This request became rental #${r?.id ?? '?'}. Cancel that rental if the booking is off; the request stays as the record of how it started.`);
  }

  let rentalId = null;
  if (action === 'approve') {
    const already = await env.DB.prepare('SELECT id FROM rentals WHERE request_id = ?1')
      .bind(id).first();
    rentalId = already ? already.id : await createRentalFromRequest(env, user, existing, body.force === true);
  }

  const status = action === 'approve' ? 'converted' : action === 'decline' ? 'declined' : 'new';
  const reason = action === 'decline' ? String(body.reason || '').trim().slice(0, 500) || null : null;
  const decidedAt = action === 'reopen' ? null : new Date().toISOString().replace(/\.\d+/, '');
  const decidedBy = action === 'reopen' ? null : user.email;

  await env.DB.prepare(
    'UPDATE requests SET status = ?1, decided_at = ?2, decided_by = ?3, decline_reason = ?4 WHERE id = ?5',
  ).bind(status, decidedAt, decidedBy, reason, id).run();
  await audit(env, user.email, `request.${action}`, 'request', id, reason);

  const request = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS()} FROM requests WHERE id = ?1`)
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

const RENTAL_COLUMNS = () => `id, request_id, created_at, created_by, status,
  CASE WHEN status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')
       THEN 1 ELSE 0 END AS stalled,
  photo_hold, delivered_by, returned_by, delivery_unlocked_at, delivery_unlocked_by,
  pickup_unlocked_at, pickup_unlocked_by,
  signed_on_behalf, agreement_manual, agreement_manual_by,
  agreement_manual_reason, confirm_token, confirm_sent_at, agreement_name, agreement_version, agreement_signed_at AS signed_at,
  square_customer_id, square_order_id, square_invoice_id, square_invoice_url, square_status,
  square_card_id, card_brand, card_last4, card_exp, card_stored_at,
  first_name, last_name, email, phone, contact_pref,
  bins, bins_returned, weeks, start_date, due_date, total_cents,
  delivery_city, delivery_address, delivery_notes, delivery_street, delivery_unit, delivery_zip,
  pickup_city, pickup_address, pickup_notes, pickup_street, pickup_unit, pickup_zip,
  agreement_signed_at, paid_at, delivered_at, returned_at, notes,
  delivery_window, pickup_window, delivery_slot, pickup_slot, reminded_delivery_at, reminded_pickup_at,
  inspected_at, inspected_by, customer_id`;

/* A kind is a word: lowercase, letters and underscores. "Hand truck" and
   "hand_truck" and "HAND-TRUCK" are the same thing and must land in the same
   bucket, or the list grows a tab per spelling. */
const itemKind = v => {
  const k = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');
  return k.slice(0, 24) || null;
};
const DEFAULT_PREFIX = { bin: 'B', dolly: 'D', hand_truck: 'HT', moving_blanket: 'MB', strap: 'S' };

const RENTAL_STATUSES = ['pending', 'confirmed', 'out', 'returned', 'cancelled'];
const now = () => new Date().toISOString().replace(/\.\d+/, '');
const dollars = c => `$${(c / 100).toFixed(2)}`;

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
async function createRentalFromRequest(env, user, req, forceOverbook = false) {
  if (req.kind !== 'reserve') {
    throw new HttpError(400, 'Only a reservation can become a rental. Take the details first with + New request.');
  }
  if (!req.bins || !req.weeks || !req.start_date) {
    throw new HttpError(400, 'This request is missing a package, length or start date.');
  }

  const due = addWeeks(req.start_date, req.weeks);

  /* Don't promise bins that are already spoken for. Refused rather than warned:
     approving is what sends the customer a confirmation link, and un-promising
     forty bins after that email has gone is a phone call nobody wants to make.
     Overriding is deliberate — sometimes you know a set is coming back early.

     An empty bin list means the fleet is unknown, not that it is zero, so that
     case says so instead of blocking every approval. */
  const fit = await canFit(env, { startDate: req.start_date, dueDate: due, bins: req.bins });
  if (!fit.fits && !forceOverbook) {
    throw new HttpError(409, fit.fleetUnknown
      ? 'There are no bins on the inventory list yet, so availability cannot be checked. Add your fleet in Inventory, or approve anyway.'
      : `Only ${fit.availableThen} bins are free on ${fit.tightestDay} — this needs ${req.bins}, short by ${fit.shortBy}. Move the date, cut the package, or approve anyway.`);
  }

  // The usual window, stamped now so it is a fact about this rental rather
  // than whatever the setting says later.
  const { defaultWindow } = await getSettings(env);
  const res = await env.DB.prepare(
    `INSERT INTO rentals (request_id, created_by, first_name, last_name, email, phone,
       contact_pref, bins, weeks, start_date, due_date, total_cents,
       delivery_city, pickup_city, delivery_window, pickup_window, customer_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16)`,
  ).bind(
    req.id, user.email, req.first_name, req.last_name, req.email, req.phone,
    req.contact_pref, req.bins, req.weeks, req.start_date, due, req.quoted_total_cents,
    req.delivery_city, req.pickup_city || req.delivery_city, defaultWindow,
    req.customer_id || await customerFor(env, req, user.email),
  ).run();

  const id = res.meta.last_row_id;
  await audit(env, user.email, 'rental.create', 'rental', id, `from request ${req.id}`);
  if (!fit.fits) {
    await audit(env, user.email, 'rental.overbooked', 'rental', id,
      fit.fleetUnknown
        ? 'approved with no bins on the inventory list'
        : `approved short by ${fit.shortBy} on ${fit.tightestDay}`);
  }
  return id;
}

async function listRentals(env, url) {
  const status = url.searchParams.get('status') || 'active';
  const binds = [];
  let where = '';

  if (status === 'active') {
    // Everything with work left in it — including bins that are back but
    // not yet looked at. Inspected and cancelled are history, on the customer.
    where = "WHERE status IN ('pending','confirmed','out') OR (status = 'returned' AND inspected_at IS NULL)";
  } else if (status === 'to_inspect') {
    where = "WHERE status = 'returned' AND inspected_at IS NULL";
  } else if (status === 'stalled') {
    // Never confirmed, and the day it was meant to go out has passed.
    where = `WHERE status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')`;
  } else if (status !== 'all') {
    if (!RENTAL_STATUSES.includes(status)) throw new HttpError(400, 'unknown status');
    binds.push(status);
    where = 'WHERE status = ?1';
  }

  const { results } = await env.DB.prepare(
    `SELECT ${RENTAL_COLUMNS()} FROM rentals ${where}
     ORDER BY start_date, id LIMIT 300`,
  ).bind(...binds).all();
  return results;
}

/* Milestones happen in an order that reflects what physically happened. Bins
   cannot come back before they went out; delivering before the agreement is
   signed or the money has arrived is possible but should be a decision.
   `soft` prerequisites can be overridden with a recorded reason; a hard one
   cannot, because no reason makes it true. */
const PREREQ = {
  agreement: [],
  paid: [],
  delivered: [
    { col: 'agreement_signed_at', soft: true,  msg: 'The agreement is not signed yet. Deliver anyway?' },
    { col: 'paid_at',             soft: true,  msg: 'This rental is not paid yet. Deliver anyway?' },
  ],
  returned: [
    { col: 'delivered_at',        soft: false, msg: 'These bins have not been delivered yet, so they cannot come back.' },
  ],
  inspected: [
    { col: 'returned_at',         soft: false, msg: 'The bins are not marked back yet — inspection comes after.' },
  ],
};

function checkPrereqs(milestone, state, body) {
  const unmet = (PREREQ[milestone] || []).filter(p => !state[p.col]);
  const hard = unmet.find(p => !p.soft);
  if (hard) throw new HttpError(409, hard.msg);
  if (unmet.length && !body.force) throw new HttpError(409, unmet[0].msg);
  return unmet.map(p => p.col);
}

const MILESTONES = {
  agreement: 'agreement_signed_at',
  paid: 'paid_at',
  delivered: 'delivered_at',
  returned: 'returned_at',
  inspected: 'inspected_at',
};

/* §8 of the agreement: cancel 48 hours or more before delivery for a full
   refund, less than that for half. Measured to the start of the delivery day
   in Mountain Time (clock.js), since "delivery on the 16th" means the 16th
   to the customer, not 00:00 UTC.

   The money itself is refunded in Square; this works out how much, says so,
   and writes it down, so nobody has to remember the rule at 9pm. */
function refundFor(rental, at = new Date()) {
  const paidCents = rental.paid_at ? (rental.total_cents || 0) : 0;
  const hoursBefore = (startOfDay(rental.start_date) - at) / 3600000;
  const percent = hoursBefore >= 48 ? 100 : 50;
  return {
    percent,
    cents: Math.round(paidCents * percent / 100),
    paid_cents: paidCents,
    hours_before: Math.round(hoursBefore),
  };
}

/* Milestones toggle rather than only set, because the commonest correction is
   marking the wrong rental delivered and needing to undo it immediately. */
async function updateRental(env, user, id, body) {
  const row = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
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
    if (body.done === false && body.milestone === 'delivered' && row.returned_at) {
      throw new HttpError(409, 'These bins are already marked back. Undo that first.');
    }

    /* A customer's e-signature is theirs, not ours. Once one exists it cannot be
       re-ticked or un-ticked from the panel — same reasoning as Square owning
       payment: the panel has no business contradicting a signed record. */
    if (body.milestone === 'agreement' && row.agreement_signed_at && !row.agreement_manual) {
      throw new HttpError(409, `${row.agreement_name} signed this on ${String(row.agreement_signed_at).slice(0, 10)}. A customer's signature cannot be changed here.`);
    }

    /* Recording it by hand is allowed — someone signs a paper copy at the door,
       or agrees on a call — but it needs a reason and is never presented as an
       e-signature. Writing a bare timestamp produced a record that looked like
       a signature and named nobody. */
    if (body.milestone === 'agreement' && body.done !== false) {
      const why = String(body.reason || '').trim().slice(0, 300);
      if (!why) {
        throw new HttpError(428, 'The customer signs through their own link. To record it here instead, say how they agreed.');
      }
      patch.agreement_manual = 1;
      patch.agreement_manual_by = user.email;
      patch.agreement_manual_reason = why;
    }
    if (body.milestone === 'agreement' && body.done === false) {
      patch.agreement_manual = 0;
      patch.agreement_manual_by = null;
      patch.agreement_manual_reason = null;
    }

    /* A rental cannot be delivered before the day it is due to go out — not
       without saying so. This mostly catches ticking the wrong rental, which is
       easy when two look alike in a list. Returns are deliberately NOT
       date-locked: customers finish early and you collect early, so a lock
       there would be overridden most weeks and stop being read. */
    if (body.done !== false && body.milestone === 'delivered' && row.start_date
        && !row.delivery_unlocked_at) {
      if (row.start_date > today() && !body.force) {
        const days = dayDiff(row.start_date, today());
        throw new HttpError(423, `This is not due out for ${days} day${days === 1 ? '' : 's'} (${row.start_date}). Mark it delivered anyway?`);
      }
      if (row.start_date > today()) {
        const days = dayDiff(row.start_date, today());
        await audit(env, user.email, 'rental.delivered_early', 'rental', id, `${days} day(s) before ${row.start_date}`);
      }
    }

    if (body.done !== false && body.milestone === 'returned' && row.due_date
        && !row.pickup_unlocked_at) {
      if (row.due_date > today() && !body.force) {
        const days = dayDiff(row.due_date, today());
        throw new HttpError(423, `These are not due back for ${days} day${days === 1 ? '' : 's'} (${row.due_date}). Mark them back anyway?`);
      }
      if (row.due_date > today()) {
        const days = dayDiff(row.due_date, today());
        await audit(env, user.email, 'rental.returned_early', 'rental', id, `${days} day(s) before ${row.due_date}`);
      }
    }

    if (body.done !== false) {
      const skipped = checkPrereqs(body.milestone, row, body);
      if (skipped.length) {
        await audit(env, user.email, `rental.${body.milestone}_early`, 'rental', id,
          `without ${skipped.join(', ')}`);
      }
    }

    patch[col] = body.done === false ? null : now();
    // Who, not just when — the audit log knows, but this is the record anyone
    // actually reads when a customer says the bins never turned up.
    if (body.milestone === 'delivered') patch.delivered_by = body.done === false ? null : user.email;
    if (body.milestone === 'returned') patch.returned_by = body.done === false ? null : user.email;
    if (body.milestone === 'inspected') patch.inspected_by = body.done === false ? null : user.email;
    if (body.done === false && body.milestone === 'returned' && row.inspected_at) {
      throw new HttpError(409, 'This rental has been inspected. Undo that first.');
    }

    /* Going out with nothing assigned: pick the free bins now, so the rental
       knows what it has without anyone typing labels. Adjustable afterwards. */
    if (body.milestone === 'delivered' && patch.delivered_at && !row.delivered_at) {
      const have = await itemsOn(env, id);
      if (!have.length) {
        try { await assignBins(env, user, row, { auto: true }); }
        catch (err) { if (!/No free bins/.test(err.message)) throw new HttpError(err.status || 400, err.message); }
      }
    }
    // Inspected with the list untouched: everything unresolved came back fine.
    if (body.milestone === 'inspected' && patch.inspected_at) await resolveRest(env, user, row);

    if (body.milestone === 'delivered' && patch.delivered_at) {
      const why = await requirePhoto(env, id, 'delivery', body.photo_reason);
      if (why) await audit(env, user.email, 'rental.delivered_no_photo', 'rental', id, why);
    }

    if (body.milestone === 'returned' && patch.returned_at) {
      const why = await requirePhoto(env, id, 'pickup', body.photo_reason);
      if (why) await audit(env, user.email, 'rental.returned_no_photo', 'rental', id, why);
    }
  }

  const ADDRESS_PARTS = ['delivery_street', 'delivery_unit', 'delivery_city', 'delivery_zip',
    'pickup_street', 'pickup_unit', 'pickup_city', 'pickup_zip'];

  /* Booking into an hour. Checked against who is on and what is already
     booked; writes the window text alongside, so the run sheet and the
     customer see the same words. `force` books it anyway — a full hour is a
     judgement, and the owner may know the second driver is free. */
  for (const kind of ['delivery', 'pickup']) {
    const key = `${kind}_slot`;
    if (!(key in body)) continue;
    if (body[key] === null || body[key] === '') { patch[key] = null; continue; }
    const date = kind === 'delivery' ? row.start_date : row.due_date;
    try {
      const text = await claimSlot(env, { date, slot: body[key], current: row[key], force: !!body.force });
      patch[key] = body[key];
      patch[`${kind}_window`] = text;
      if (body.force) await audit(env, user.email, 'rental.slot_forced', 'rental', id, `${kind} ${text} on ${date}`);
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
  }

  // "6–8pm", "after 5", "before noon" — a phrase, not a schedule.
  for (const w of ['delivery_window', 'pickup_window']) {
    if (w in body) {
      const v = clean(body[w], 40);
      if (body[w] && String(body[w]).trim().length > 40) throw new HttpError(400, 'A window is a short phrase like "6–8pm".');
      patch[w] = v;
    }
  }

  /* After the visit the address is a record of where the bins actually went,
     not a field. Editing it then rewrites history — and it is the address the
     photo was taken at. */
  const touches = prefix => ADDRESS_PARTS.some(f => f.startsWith(prefix) && f in body);
  if (row.delivered_at && touches('delivery_')) {
    throw new HttpError(409, 'These bins have already been delivered. The address is the record of where they went — reopen that step if it is genuinely wrong.');
  }
  if (row.returned_at && touches('pickup_')) {
    throw new HttpError(409, 'These bins have already been collected. Reopen that step if the pickup address is genuinely wrong.');
  }

  let addressChanged = false;
  for (const f of ADDRESS_PARTS) {
    if (f in body) { patch[f] = clean(body[f], 200); addressChanged = true; }
  }
  // Keep the one-line form in step with the parts, since the run sheet and the
  // customer's recap read it.
  if (addressChanged) {
    const line = k => [patch[`${k}_street`], patch[`${k}_unit`],
      [patch[`${k}_city`], 'UT', patch[`${k}_zip`]].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    patch.delivery_address = line('delivery') || patch.delivery_address;
    patch.pickup_address = line('pickup') || patch.pickup_address;
  }
  let refund = null;
  if ('status' in body) {
    requireOwner(user, 'cancel or reinstate a rental');
    if (!RENTAL_STATUSES.includes(body.status)) throw new HttpError(400, 'unknown status');

    if (body.status === 'cancelled') {
      /* Cancelling a rental whose bins are at someone's house is not a
         cancellation, it is a loose end. And cancelling a paid one without
         saying what happened to the money leaves a customer out of pocket with
         no record of why. */
      if (row.returned_at) {
        /* It happened: the bins went out, came back, and the money was taken.
           Cancelling would say none of that occurred. A refund belongs in
           Square and an explanation belongs in the notes. */
        throw new HttpError(409, 'This rental is finished — the bins went out and came back. If something needs putting right, refund it in Square and add a note here.');
      }
      if (row.delivered_at && !row.returned_at) {
        throw new HttpError(409, 'These bins are still out. Mark them back before cancelling, or this rental disappears with your bins at a customer\'s house.');
      }
      const why = String(body.reason || '').trim().slice(0, 300);
      if (!why) throw new HttpError(428, 'Why is this being cancelled?');

      if (row.paid_at) {
        refund = refundFor(row);
        await audit(env, user.email, 'rental.cancelled_after_payment', 'rental', id,
          `${why} — ${dollars(refund.cents)} (${refund.percent}%) to refund in Square, ${
            refund.hours_before >= 48 ? '48h or more' : 'under 48h'} before delivery`);
      }
      await audit(env, user.email, 'rental.cancel', 'rental', id, why);
      await releaseBins(env, id);
    }

    patch.status = body.status;
  }

  patch.status = statusFrom(patch);
  if (body.status === 'cancelled') patch.status = 'cancelled';

  await env.DB.prepare(
    `UPDATE rentals SET status=?1, agreement_signed_at=?2, paid_at=?3, delivered_at=?4,
       returned_at=?5, delivery_address=?6, pickup_address=?7, delivery_city=?8,
       pickup_city=?9, notes=?10, agreement_manual=?11, agreement_manual_by=?12,
       agreement_manual_reason=?13,
       delivery_street=?14, delivery_unit=?15, delivery_zip=?16,
       pickup_street=?17, pickup_unit=?18, pickup_zip=?19,
       delivered_by=?20, returned_by=?21, delivery_window=?23, pickup_window=?24,
       delivery_slot=?25, pickup_slot=?26, inspected_at=?27, inspected_by=?28
     WHERE id=?22`,
  ).bind(
    patch.status, patch.agreement_signed_at, patch.paid_at, patch.delivered_at,
    patch.returned_at, patch.delivery_address, patch.pickup_address,
    patch.delivery_city, patch.pickup_city, patch.notes,
    patch.agreement_manual ? 1 : 0, patch.agreement_manual_by, patch.agreement_manual_reason,
    patch.delivery_street, patch.delivery_unit, patch.delivery_zip,
    patch.pickup_street, patch.pickup_unit, patch.pickup_zip,
    patch.delivered_by, patch.returned_by,
    id, patch.delivery_window, patch.pickup_window, patch.delivery_slot, patch.pickup_slot,
    patch.inspected_at, patch.inspected_by,
  ).run();

  // A milestone or a cancellation has already been written up above; only an
  // address or notes edit needs its own line, and it should say what changed.
  if (body.milestone) {
    await audit(env, user.email, `rental.${body.milestone}`, 'rental', id, `done=${body.done !== false}`);
  } else if (!('status' in body)) {
    const changed = Object.keys(body).filter(k => ADDRESS_PARTS.includes(k) || k === 'notes' || k.endsWith('_window') || k.endsWith('_slot'));
    if (changed.length) await audit(env, user.email, 'rental.update', 'rental', id, changed.join(', '));
  } else if (body.status !== 'cancelled') {
    await audit(env, user.email, 'rental.reinstate', 'rental', id, null);
  }

  const updated = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(id).first();
  return refund ? { rental: updated, refund } : { rental: updated };
}

/* Moving a rental to a new start date. The commonest change there is — a
   closing slips, a landlord changes the handover — and until now it meant
   cancelling and rebooking, which lost the link, the signature and the
   payment.

   Weeks stay the same, so the due date moves with the start. The bins are
   re-checked for the new span with this rental's own hold ignored. Once the
   bins are out there is nothing to move: that is an extension. */
async function rescheduleRental(env, user, id, body) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (rental.status === 'cancelled') throw new HttpError(400, 'This rental is cancelled. Reinstate it first.');
  if (rental.delivered_at) throw new HttpError(409, 'These bins are already out. To keep them longer, add an extension.');

  const start = isoDate(body.start_date);
  if (!start) throw new HttpError(400, 'A new start date is required.');
    if (start < today()) throw new HttpError(400, 'That date has already passed.');
  const dayOff = await closedDayName(env, start);
  if (dayOff) throw new HttpError(400, `We do not deliver on ${dayOff}s.`);
  const closed = await blackoutOn(env, start);
  if (closed) throw new HttpError(400, `We are not delivering on ${start} — ${closed}.`);
  if (start === rental.start_date) throw new HttpError(400, 'That is already the start date.');

  const due = addWeeks(start, rental.weeks);
  const fit = await canFit(env, { startDate: start, dueDate: due, bins: rental.bins, excludeRentalId: id });
  if (!fit.fits && !fit.fleetUnknown) {
    throw new HttpError(409, `Only ${fit.availableThen} bins are free on ${fit.tightestDay} — this needs ${rental.bins}. Try another date.`);
  }

  await env.DB.prepare('UPDATE rentals SET start_date = ?1, due_date = ?2 WHERE id = ?3')
    .bind(start, due, id).run();

  /* The agreement the customer signed names the dates in its first clause.
     Moving them afterwards does not void it — §8 allows rescheduling — but
     the record should show the signature predates the change. */
  const signed = !!rental.agreement_signed_at;
  const why = clean(body.reason, 300);
  await audit(env, user.email, 'rental.reschedule', 'rental', id,
    `${rental.start_date} → ${start}${why ? ` — ${why}` : ''}${signed ? ' (after signing)' : ''}`);

  if (rental.email) {
    await env.MAILER.sendRescheduled({
      to: rental.email, name: rental.first_name, bins: rental.bins, weeks: rental.weeks,
      startDate: start, dueDate: due, previousStart: rental.start_date, reason: why,
    }).catch(err => console.log('reschedule mail failed', err.message));
  }

  const updated = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(id).first();
  return {
    rental: updated,
    note: signed ? 'The signed agreement names the old dates. The change is on record; the customer has been emailed the new ones.' : null,
  };
}

/* Starting a rental means giving the customer their link — nothing more.
   The invoice is raised by the confirmation flow once their card is on file,
   because an invoice created before then has no card to charge and Square will
   not attach one afterwards. Creating it here was the reason three attempts at
   automatic payment quietly did nothing. */
async function invoiceRental(env, user, id) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (rental.status === 'cancelled') throw new HttpError(400, 'This rental is cancelled.');
  if (!rental.email) throw new HttpError(400, 'This rental has no email address to send to.');

  if (!rental.confirm_token) {
    await env.DB.prepare('UPDATE rentals SET confirm_token = ?1 WHERE id = ?2')
      .bind(crypto.randomUUID(), id).run();
  }

  await sendConfirmLink(env, user, id);
  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* The customer always gets this by email — the agreement and payment are the
   record of the deal, and an email is what they can find again in six months.
   Their contact preference governs informal chasing, not the paperwork. */
async function sendConfirmLink(env, user, id) {
  const r = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
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
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
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
  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* ---------- schedule ----------

   What someone is actually doing tonight. Deliveries and collections are
   different jobs at different addresses, but they happen on the same run, so
   they belong in one list ordered by the evening rather than in two tabs.

   Sundays are included but marked: the business does not work them, and a job
   landing on one is a mistake worth seeing rather than hiding. */

async function schedule(env, from, days) {
  const to = addDays(from, Math.max(0, days - 1));

  const { results: drops } = await env.DB.prepare(
    `SELECT id, 'deliver' AS job, start_date AS on_date, bins, first_name, last_name,
            phone, email, contact_pref, delivery_address AS address, delivery_city AS city,
            delivery_unit AS unit, delivery_zip AS zip,
            delivery_notes AS notes, delivered_at AS done_at, delivered_by AS done_by,
            delivery_window AS window, delivery_slot AS slot, status, agreement_signed_at, paid_at
     FROM rentals
     WHERE status NOT IN ('cancelled') AND start_date IS NOT NULL
       AND date(start_date) BETWEEN date(?1) AND date(?2)`,
  ).bind(from, to).all();

  const { results: collects } = await env.DB.prepare(
    `SELECT id, 'collect' AS job, due_date AS on_date, bins, first_name, last_name,
            phone, email, contact_pref, pickup_address AS address, pickup_city AS city,
            pickup_unit AS unit, pickup_zip AS zip,
            pickup_notes AS notes, returned_at AS done_at, returned_by AS done_by,
            pickup_window AS window, pickup_slot AS slot, status, agreement_signed_at, paid_at
     FROM rentals
     WHERE status NOT IN ('cancelled') AND due_date IS NOT NULL
       AND date(due_date) BETWEEN date(?1) AND date(?2)
       AND delivered_at IS NOT NULL`,
  ).bind(from, to).all();

  const { results: closed } = await env.DB.prepare(
    'SELECT date, reason FROM blackouts WHERE date BETWEEN ?1 AND ?2').bind(from, to).all();
  const blackout = new Map(closed.map(b => [b.date, b.reason || 'closed']));

  const cov = await coverage(env, from, days);
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    byDay.set(date, {
      date,
      closedDay: cov[i].closedDay,
      blackout: blackout.get(date) || null,
      staff: cov[i].staff,
      staffNote: cov[i].note,
      open: cov[i].open,
      jobs: [],
      binsOut: 0,
      binsBack: 0,
    });
  }

  for (const j of [...drops, ...collects]) {
    const day = byDay.get(j.on_date);
    if (!day) continue;
    day.jobs.push(j);
    if (j.job === 'deliver') day.binsOut += j.bins || 0;
    else day.binsBack += j.bins || 0;
  }

  // Collections before deliveries within a day: bins coming back can go
  // straight out again, and an empty van is easier to load than a full one.
  // Within a kind, by the window promised — "4–5pm" before "7–8pm" — read
  // off the first number in it; a window with no number goes last.
  const hour = w => {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(w || '');
    if (!m) return 99;
    let h = parseInt(m[1], 10);
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (!m[3] && h < 9) h += 12;   // "6–8" on an evening run means pm
    return h + (m[2] ? parseInt(m[2], 10) / 60 : 0);
  };
  for (const day of byDay.values()) {
    day.jobs.sort((a, b) => a.job !== b.job ? (a.job === 'collect' ? -1 : 1)
      : hour(a.window) - hour(b.window) || a.id - b.id);
  }

  return [...byDay.values()];
}

/* ---------- charges ----------

   Raised against the card on file under §4, on a separate invoice from the
   rental itself: the rental was settled at delivery, and this is what came
   afterwards. Nothing is charged automatically — see charges.js. */

const CHARGE_KINDS = ['late', 'missing', 'damage', 'other'];
const CHARGE_LINE = {
  late:    'Late return',
  missing: 'Unreturned bins',
  damage:  'Damage beyond normal wear',
  other:   'Additional charge',
};

async function addCharge(env, user, rentalId, body) {
  const rental = await env.DB.prepare('SELECT id FROM rentals WHERE id = ?1').bind(rentalId).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (!CHARGE_KINDS.includes(body.kind)) {
    throw new HttpError(400, 'A charge is late, missing, damage or other.');
  }
  const qty = parseInt(body.qty, 10);
  const unit = parseInt(body.unit_cents, 10);
  if (!Number.isFinite(qty) || qty < 1 || qty > 1000) throw new HttpError(400, 'Quantity must be between 1 and 1000.');
  if (!Number.isFinite(unit) || unit < 1 || unit > 500000) throw new HttpError(400, 'Unit price must be between $0.01 and $5,000.');
  // The customer reads this line on their invoice, so it cannot be blank.
  const reason = clean(body.reason, 300);
  if (!reason) throw new HttpError(400, 'Say what the charge is for — the customer sees this on the invoice.');

  const amount = qty * unit;
  await env.DB.prepare(
    `INSERT INTO charges (rental_id, kind, qty, unit_cents, amount_cents, taxable, reason, bin_labels, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(rentalId, body.kind, qty, unit, amount, body.taxable === false ? 0 : 1,
         reason, clean(body.bin_labels, 500), user.email).run();
  await audit(env, user.email, 'charge.add', 'rental', rentalId,
    `${body.kind} — ${qty} × ${dollars(unit)} = ${dollars(amount)} — ${reason}`);
  return listCharges(env, rentalId);
}

/* Waiving is a decision, so it is recorded rather than deleted. Once money has
   moved, Square is the place to undo it — a row flipped here would say the
   customer was not charged when their statement says otherwise. */
async function waiveCharge(env, user, chargeId, body) {
  const row = await env.DB.prepare(
    'SELECT id, rental_id, kind, amount_cents, invoiced_at, paid_at, waived_at FROM charges WHERE id = ?1',
  ).bind(chargeId).first();
  if (!row) throw new HttpError(404, 'no such charge');
  if (row.waived_at) return listCharges(env, row.rental_id);
  if (row.paid_at) throw new HttpError(409, 'That has been paid. Refund it in Square — waiving it here would not give the money back.');
  if (row.invoiced_at) throw new HttpError(409, 'That is already on an invoice with the customer. Cancel the invoice in Square first.');
  const reason = clean(body.reason, 300);
  if (!reason) throw new HttpError(400, 'Say why — this is the record of the decision.');

  await env.DB.prepare(
    `UPDATE charges SET waived_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       waived_by = ?1, waive_reason = ?2 WHERE id = ?3`,
  ).bind(user.email, reason, chargeId).run();
  await audit(env, user.email, 'charge.waive', 'rental', row.rental_id,
    `${row.kind} ${dollars(row.amount_cents)} waived — ${reason}`);
  return listCharges(env, row.rental_id);
}

/* One invoice for everything outstanding. Separate invoices per charge would
   mean three emails and three card authorisations for one bad rental. */
async function invoiceCharges(env, user, rentalId) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
    .bind(rentalId).first();
  if (!rental) throw new HttpError(404, 'no such rental');

  const due = outstanding(await listCharges(env, rentalId));
  if (!due.length) throw new HttpError(400, 'Nothing outstanding to invoice.');

  const when = today();
  let sq;
  try {
    sq = await createInvoice(env, rental, {
      lineItems: due.map(c => ({
        name: CHARGE_LINE[c.kind],
        quantity: c.qty,
        unitCents: c.unit_cents,
        amountCents: c.amount_cents,
        note: c.reason + (c.bin_labels ? ` — ${c.bin_labels}` : ''),
        taxable: !!c.taxable,
      })),
      referenceId: `rental-${rental.id}-charges`,
      serviceDate: when,
      dueDate: when,
      cardId: rental.square_card_id || undefined,
      title: `Beehive Bin Co. — rental #${rental.id}`,
      description: rental.square_card_id
        ? 'Charged to the card you kept on file, as agreed in section 4 of your rental agreement.'
        : 'Charges on your bin rental, under section 4 of your rental agreement.',
    });
  } catch (err) {
    if (err instanceof SquareError) throw new HttpError(err.status === 503 ? 503 : 400, err.message);
    throw err;
  }

  for (const c of due) {
    await env.DB.prepare(
      `UPDATE charges SET square_invoice_id = ?1, square_invoice_url = ?2, square_status = ?3,
         invoiced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?4`,
    ).bind(sq.square_invoice_id, sq.square_invoice_url, sq.square_status, c.id).run();
  }
  const total = due.reduce((n, c) => n + c.amount_cents, 0);
  await audit(env, user.email, 'charge.invoice', 'rental', rentalId,
    `${due.length} charge${due.length === 1 ? '' : 's'}, ${dollars(total)} — ${
      rental.square_card_id ? `card on file ••${rental.card_last4}` : 'no card on file, invoice emailed'}`);
  return listCharges(env, rentalId);
}

/* How many actually came back. Counted, not assumed: "we never counted" and
   "all of them came back" are different answers, and only one of them supports
   a missing-bin charge. */
async function recordReturnedCount(env, user, rentalId, body) {
  const rental = await env.DB.prepare('SELECT id, bins, bins_returned FROM rentals WHERE id = ?1')
    .bind(rentalId).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  const n = body.bins_returned === null || body.bins_returned === '' ? null : parseInt(body.bins_returned, 10);
  if (n !== null && (!Number.isFinite(n) || n < 0 || n > rental.bins)) {
    throw new HttpError(400, `That has to be between 0 and ${rental.bins}.`);
  }
  await env.DB.prepare('UPDATE rentals SET bins_returned = ?1 WHERE id = ?2').bind(n, rentalId).run();
  await audit(env, user.email, 'rental.counted', 'rental', rentalId,
    n === null ? 'count cleared' : `${n} of ${rental.bins} bins back`);
  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(rentalId).first();
}

/* ---------- internal notes ----------

   Append-only, attributed, and never shown to a customer — the public Worker
   does not read this table at all. */

const ENTITIES = ['request', 'rental', 'customer'];

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

  const table = `${entity}s`;
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

  /* A photo is evidence of a visit, so there has to have been one. Pickup needs
     a delivery to come back from; delivery needs to be at least due — a photo
     dated a week before the bins went out is worse than no photo, because it
     looks like proof of something that had not happened. Once the lock on the
     milestone is opened, the visit is on the record and photos follow. */
  const state = await env.DB.prepare(
    `SELECT start_date, due_date, delivered_at, returned_at,
            delivery_unlocked_at, pickup_unlocked_at FROM rentals WHERE id = ?1`)
    .bind(rentalId).first();

  if (kind === 'pickup' && !state?.delivered_at) {
    throw new HttpError(409, 'These bins have not been delivered yet, so there is nothing to photograph coming back.');
  }

  if (kind === 'pickup' && !state?.returned_at && !state?.pickup_unlocked_at
      && state?.due_date && state.due_date > today()) {
    throw new HttpError(423, `These are not due back until ${state.due_date}. Unlock the pickup step first if you are collecting early.`);
  }

  if (kind === 'delivery' && !state?.delivered_at && !state?.delivery_unlocked_at
      && state?.start_date && state.start_date > today()) {
    throw new HttpError(423, `These bins are not due out until ${state.start_date}. Unlock the delivery step first if you are dropping them early.`);
  }

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

  /* Uploading no longer marks the visit on its own. Photos are added one at a
     time but a visit is one event, so the panel stages them and commits the lot
     with the milestone in a single deliberate action — otherwise the first
     photo decides the delivery happened while you are still taking the others. */
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
    'SELECT id, rental_id, kind, r2_key, taken_by, deleted_at FROM rental_photos WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'no such photo');
  if (row.deleted_at) return listPhotos(env, row.rental_id);

  /* Once the visit is marked done these photos are the evidence for it, and
     evidence that can be tidied afterwards is worth much less. Reopening the
     step is the way out — deliberate, and recorded — rather than quietly
     deleting the picture underneath a completed record. */
  const rental = await env.DB.prepare('SELECT delivered_at, returned_at FROM rentals WHERE id = ?1')
    .bind(row.rental_id).first();
  const committed = row.kind === 'delivery' ? rental?.delivered_at : rental?.returned_at;
  if (committed) {
    throw new HttpError(409, `This is the record of a ${row.kind === 'delivery' ? 'delivery' : 'collection'} that has been marked done. Reopen that step first if it needs changing.`);
  }

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

/* ---------- photo retention ----------

   The privacy policy and the rental agreement both promise photos are gone
   within 90 days of a rental ending. A promise nothing enforces is just wording,
   so this runs on a schedule and actually deletes them.

   The clock starts at whichever end date we have: when the bins actually came
   back, or the day they were due if a rental never closed out. A rental on
   photo_hold is skipped — an open dispute is exactly when deleting the evidence
   on schedule would be the wrong outcome. */

const RETENTION_DAYS = 90;

async function sweepPhotos(env) {
  const cutoff = `-${RETENTION_DAYS} days`;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.r2_key, p.rental_id
     FROM rental_photos p JOIN rentals r ON r.id = p.rental_id
     WHERE p.deleted_at IS NULL
       AND r.photo_hold = 0
       AND date(coalesce(r.returned_at, r.due_date)) < date(?2, ?1)
     LIMIT 500`,
  ).bind(cutoff, today()).all();

  if (!results.length) return { deleted: 0 };

  let deleted = 0;
  for (const row of results) {
    try {
      await env.PHOTOS.delete(row.r2_key);
      // The row survives with a deletion stamp: "there was a photo and it was
      // removed on schedule" is a different claim from "there was never one".
      await env.DB.prepare(
        'UPDATE rental_photos SET deleted_at = ?1, deleted_by = ?2 WHERE id = ?3',
      ).bind(now(), 'retention', row.id).run();
      deleted++;
    } catch (err) {
      console.log('retention: could not delete', row.r2_key, err.message);
    }
  }

  await env.DB.prepare(
    'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
  ).bind('retention', 'photos.swept', null, null,
         `${deleted} photo(s) past ${RETENTION_DAYS} days`).run();

  return { deleted };
}

/* ---------- reminders ----------

   The day before: "we're coming tomorrow between 6 and 8, have them at the
   door". Sent once per visit, in the morning, only for rentals that are
   actually going ahead — a reminder for an unsigned, unpaid booking would be
   a promise nobody made. */
async function sendReminders(env) {
  const tomorrow = addDays(today(), 1);
  const { results: drops } = await env.DB.prepare(
    `SELECT ${RENTAL_COLUMNS()} FROM rentals
     WHERE status != 'cancelled' AND agreement_signed_at IS NOT NULL AND paid_at IS NOT NULL
       AND delivered_at IS NULL AND start_date = ?1 AND reminded_delivery_at IS NULL AND email IS NOT NULL`,
  ).bind(tomorrow).all();
  const { results: collects } = await env.DB.prepare(
    `SELECT ${RENTAL_COLUMNS()} FROM rentals
     WHERE status != 'cancelled' AND delivered_at IS NOT NULL AND returned_at IS NULL
       AND due_date = ?1 AND reminded_pickup_at IS NULL AND email IS NOT NULL`,
  ).bind(tomorrow).all();

  let sent = 0;
  for (const [job, rows] of [['deliver', drops], ['collect', collects]]) {
    for (const r of rows) {
      const res = await env.MAILER.sendReminder({
        to: r.email, name: r.first_name, job, date: tomorrow, bins: r.bins,
        window: job === 'deliver' ? r.delivery_window : r.pickup_window,
        address: job === 'deliver' ? r.delivery_address : r.pickup_address,
        dueDate: r.due_date,
      }).catch(err => ({ ok: false, error: err.message }));
      if (!res?.ok) { console.log('reminder failed', r.id, res?.error); continue; }
      await env.DB.prepare(
        `UPDATE rentals SET ${job === 'deliver' ? 'reminded_delivery_at' : 'reminded_pickup_at'} = ?1 WHERE id = ?2`,
      ).bind(now(), r.id).run();
      await audit(env, 'reminders', `rental.reminded_${job}`, 'rental', r.id, r.email);
      sent++;
    }
  }
  return { sent, for: tomorrow };
}

/* ---------- extensions ----------

   A customer keeping the bins longer. Priced at the package's extra-week rate,
   invoiced separately — the original invoice is a document the customer already
   has, and rewriting it would be dishonest — and taxed at the rate in force
   when the extra weeks are sold, not when the rental began. */

const listExtensions = (env, rentalId) => env.DB.prepare(
  `SELECT id, weeks, amount_cents, previous_due_date, new_due_date, reason,
          created_at, created_by, square_invoice_url, square_status, paid_at
   FROM rental_extensions WHERE rental_id = ?1 ORDER BY created_at`,
).bind(rentalId).all().then(r => r.results);

async function extendRental(env, user, id, body) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');

  /* Extending is only meaningful while the customer has the bins, or is about
     to. Nothing to extend on a rental that never went out or already came back
     — that is a new rental, not more weeks on an old one. */
  if (rental.status === 'cancelled') throw new HttpError(400, 'This rental is cancelled.');
  if (rental.returned_at) throw new HttpError(409, 'These bins are already back. An extension after the fact is a new rental.');
  if (!rental.agreement_signed_at || !rental.paid_at) {
    throw new HttpError(409, 'Finish the original rental first — it is not signed and paid yet.');
  }

  const weeks = parseInt(body.weeks, 10);
  if (!Number.isFinite(weeks) || weeks < 1 || weeks > 12) {
    throw new HttpError(400, 'Extensions run from 1 to 12 weeks.');
  }
  if (EXTRA[rental.bins] == null) {
    throw new HttpError(400, `No extra-week rate on file for a ${rental.bins}-bin package.`);
  }

  // Priced from the source of truth, with an override for a negotiated case —
  // the same shape as a phone-in quote.
  let amount = EXTRA[rental.bins] * weeks;
  const override = String(body.amount ?? '').trim();
  if (override) {
    const m = /([\d,]+(?:\.\d{1,2})?)/.exec(override);
    if (!m) throw new HttpError(400, 'That amount is not a number.');
    amount = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
  }

  const previousDue = rental.due_date;
  const newDue = addWeeks(previousDue, weeks);

  // The extra weeks are a hold on bins someone else may already have booked.
  // Checked before anything is written or sent, so a refusal leaves no trace.
  const fit = await canFit(env, { startDate: addDays(previousDue, 1), dueDate: newDue, bins: rental.bins, excludeRentalId: id });
  if (!fit.fits && !fit.fleetUnknown) {
    throw new HttpError(409, `Only ${fit.availableThen} bins are free on ${fit.tightestDay} — another customer has them. A shorter extension may fit.`);
  }

  const res = await env.DB.prepare(
    `INSERT INTO rental_extensions (rental_id, weeks, amount_cents, previous_due_date,
       new_due_date, reason, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(id, weeks, amount, previousDue, newDue,
         clean(body.reason, 300), user.email).run();
  const extId = res.meta.last_row_id;

  let sq;
  try {
    sq = await createInvoice(env, rental, {
      amountCents: amount,
      lineName: `${weeks === 1 ? '1 extra week' : `${weeks} extra weeks`} — ${rental.bins} bins`,
      lineNote: `Return date moves from ${previousDue} to ${newDue}`,
      title: `Bin rental extension — ${weeks === 1 ? '1 week' : `${weeks} weeks`}`,
      description: `Keeping the bins to ${newDue}.`,
      // Taxed and dated as of today: this is sold now, not when the rental began.
      serviceDate: today(),
      dueDate: today(),
    });
  } catch (err) {
    // The extension row would otherwise linger with no way to pay for it.
    await env.DB.prepare('DELETE FROM rental_extensions WHERE id = ?1').bind(extId).run();
    if (err instanceof SquareError) throw new HttpError(err.status === 503 ? 503 : 400, err.message);
    throw err;
  }

  await env.DB.prepare(
    `UPDATE rental_extensions SET square_order_id=?1, square_invoice_id=?2,
       square_invoice_url=?3, square_status=?4 WHERE id=?5`,
  ).bind(sq.square_order_id, sq.square_invoice_id, sq.square_invoice_url,
         sq.square_status, extId).run();

  // The rental's due date moves now, not on payment: the customer has the bins
  // for those weeks either way, and an overdue flag firing while an extension
  // invoice is outstanding would be wrong.
  await env.DB.prepare('UPDATE rentals SET due_date = ?1 WHERE id = ?2')
    .bind(newDue, id).run();

  await audit(env, user.email, 'rental.extend', 'rental', id,
    `${weeks} week(s), ${(amount / 100).toFixed(2)}, due ${previousDue} → ${newDue}`);

  return listExtensions(env, id);
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

  if (path === '/me' && method === 'GET') return json({ user, booking_host: env.BOOKING_HOST, cities: SERVICE_CITIES });

  if (path === '/stats' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT status, COUNT(*) AS count FROM requests GROUP BY status',
    ).all();
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of results) counts[r.status] = r.count;

    const { count: lapsed } = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM requests WHERE status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')`,
    ).first();
    counts.lapsed = lapsed;
    counts.new = Math.max(0, counts.new - lapsed);   // the badge should count live work

    const { count: activeRentals } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status IN ('pending','confirmed','out') OR (status = 'returned' AND inspected_at IS NULL)",
    ).first();
    const { count: overdue } = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM rentals WHERE status = 'out' AND due_date < date('${today()}')`,
    ).first();
    const { count: stalled } = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM rentals WHERE status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')`,
    ).first();

    const { count: toInspect } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status = 'returned' AND inspected_at IS NULL").first();
    return json({ counts, rentals: { active: activeRentals, overdue, stalled, to_inspect: toInspect } });
  }

  if (path === '/requests') {
    if (method === 'GET') {
      const requests = await listRequests(env, url);
      const fit = await stoplights(env, requests);
      return json({ requests: requests.map(r => ({ ...r, fit: fit[r.id] })) });
    }
    if (method === 'POST') return json({ request: await createRequest(env, user, body) }, 201);
  }

  if ((m = match(/^\/requests\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const row = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS()}, raw_json FROM requests WHERE id = ?1`)
        .bind(id).first();
      if (!row) throw new HttpError(404, 'no such request');
      row.fit = (await stoplights(env, [row]))[row.id];
      return json({ request: row });
    }
    if (method === 'PATCH') {
      const row = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS()} FROM requests WHERE id = ?1`).bind(id).first();
      if (!row) throw new HttpError(404, 'no such request');
      /* A lapsed request is a person who wanted bins on a day that passed.
         The answer is a new date, which makes it a live request again — or a
         decline, which files them under customers for next time. */
      if ('start_date' in body) {
        requireOwner(user, 'change a request');
        if (row.status !== 'new') throw new HttpError(409, 'Only an open request can be re-dated.');
        const start = isoDate(body.start_date);
        if (!start || start < today()) throw new HttpError(400, 'Pick a date that has not passed.');
        const dayOff = await closedDayName(env, start);
        if (dayOff) throw new HttpError(400, `We do not deliver on ${dayOff}s.`);
        const closed = await blackoutOn(env, start);
        if (closed) throw new HttpError(400, `We are not delivering on ${start} — ${closed}.`);
        await env.DB.prepare('UPDATE requests SET start_date = ?1, return_date = ?2 WHERE id = ?3')
          .bind(start, row.weeks ? addWeeks(start, row.weeks) : null, id).run();
        await audit(env, user.email, 'request.redated', 'request', id, `${row.start_date} → ${start}`);
      }
      const updated = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS()} FROM requests WHERE id = ?1`).bind(id).first();
      updated.fit = (await stoplights(env, [updated]))[updated.id];
      return json({ request: updated });
    }
  }

  if ((m = match(/^\/requests\/(\d+)\/decision$/)) && method === 'POST') {
    requireOwner(user, 'approve or decline a request');
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
      const row = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
        .bind(rid).first();
      if (!row) throw new HttpError(404, 'no such rental');
      // The panel should quote the same number the customer was shown.
      try {
        const { rate } = rateFor(row.delivery_city, row.start_date);
        row.tax_cents = Math.round((row.total_cents || 0) * parseFloat(rate) / 100);
        row.tax_rate = rate;
      } catch { row.tax_cents = null; }
      return json({ rental: row });
    }
    if (method === 'PATCH') return json(await updateRental(env, user, rid, body));
  }

  if ((m = match(/^\/rentals\/(\d+)\/cancel-preview$/)) && method === 'GET') {
    const r = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(Number(m[1])).first();
    if (!r) throw new HttpError(404, 'no such rental');
    return json(refundFor(r));
  }
  if ((m = match(/^\/rentals\/(\d+)\/reschedule$/)) && method === 'POST') {
    requireOwner(user, 'move a rental');
    return json(await rescheduleRental(env, user, Number(m[1]), body));
  }

  if ((m = match(/^\/rentals\/(\d+)\/invoice$/)) && method === 'POST') {
    requireOwner(user, 'start a rental');
    return json({ rental: await invoiceRental(env, user, Number(m[1])) });
  }
  if ((m = match(/^\/rentals\/(\d+)\/photos$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') return json({ photos: await listPhotos(env, rid) });
    if (method === 'POST') return json({ photos: await uploadPhoto(request, env, user, rid, url) }, 201);
  }

  /* Opening the lock is separate from marking the step done. Conflating them
     meant "unlock" tried to tick the box and immediately demanded a photo that
     could not be taken yet. */
  if ((m = match(/^\/rentals\/(\d+)\/unlock$/)) && method === 'POST') {
    const rid = Number(m[1]);
    const which = body.step === 'returned' ? 'pickup' : 'delivery';
    const row = await env.DB.prepare('SELECT id, start_date, due_date FROM rentals WHERE id = ?1')
      .bind(rid).first();
    if (!row) throw new HttpError(404, 'no such rental');
    await env.DB.prepare(
      `UPDATE rentals SET ${which}_unlocked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         ${which}_unlocked_by = ?1 WHERE id = ?2`,
    ).bind(user.email, rid).run();
    await audit(env, user.email, `rental.${which}_unlocked`, 'rental', rid,
      `before its date of ${which === 'pickup' ? row.due_date : row.start_date}`);
    return json({ rental: await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(rid).first() });
  }

  if ((m = match(/^\/rentals\/(\d+)\/photo-hold$/)) && method === 'POST') {
    const rid = Number(m[1]);
    const on = body.hold ? 1 : 0;
    const res = await env.DB.prepare('UPDATE rentals SET photo_hold = ?1 WHERE id = ?2')
      .bind(on, rid).run();
    if (!res.meta.changes) throw new HttpError(404, 'no such rental');
    await audit(env, user.email, on ? 'rental.photo_hold_on' : 'rental.photo_hold_off', 'rental', rid);
    return json({ photo_hold: !!on });
  }

  if (path === '/photos/sweep' && method === 'POST') {
    requireOwner(user);
    return json(await sweepPhotos(env));
  }

  if ((m = match(/^\/photos\/(\d+)$/)) && method === 'DELETE') {
    return json({ photos: await deletePhoto(env, user, Number(m[1])) });
  }

  if (path.startsWith('/photo/') && method === 'GET') {
    return servePhoto(env, decodeURIComponent(path.slice('/photo/'.length)));
  }

  if ((m = match(/^\/rentals\/(\d+)\/send$/)) && method === 'POST') {
    requireOwner(user, 'send the confirmation link');
    const rid = Number(m[1]);
    await sendConfirmLink(env, user, rid);
    return json({ rental: await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(rid).first() });
  }

  if ((m = match(/^\/rentals\/(\d+)\/charges$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') {
      const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`)
        .bind(rid).first();
      if (!rental) throw new HttpError(404, 'no such rental');
      const { proposals: suggested, charges, flagged } = await proposals(env, rental);
      return json({
        charges, proposals: suggested, flagged,
        owed_cents: owedCents(charges),
        outstanding_cents: outstanding(charges).reduce((n, c) => n + c.amount_cents, 0),
        card: rental.square_card_id
          ? { brand: rental.card_brand, last4: rental.card_last4, exp: rental.card_exp } : null,
      });
    }
    if (method === 'POST') { requireOwner(user, 'add a charge'); return json({ charges: await addCharge(env, user, rid, body) }, 201); }
  }

  if ((m = match(/^\/rentals\/(\d+)\/charges\/invoice$/)) && method === 'POST') {
    requireOwner(user, 'charge a customer');
    return json({ charges: await invoiceCharges(env, user, Number(m[1])) });
  }

  if ((m = match(/^\/charges\/(\d+)\/waive$/)) && method === 'POST') {
    requireOwner(user, 'waive a charge');
    return json({ charges: await waiveCharge(env, user, Number(m[1]), body) });
  }

  /* Which bins are on this rental. */
  if ((m = match(/^\/rentals\/(\d+)\/items(?:\/(inspect|\d+))?$/))) {
    const rid = Number(m[1]);
    const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE id = ?1`).bind(rid).first();
    if (!rental) throw new HttpError(404, 'no such rental');
    try {
      if (!m[2] && method === 'GET') return json({ items: await itemsOn(env, rid) });
      if (!m[2] && method === 'POST') return json(await assignBins(env, user, rental, body), 201);
      if (m[2] === 'inspect' && method === 'POST') return json(await inspectBins(env, user, rental, body));
      if (m[2] && m[2] !== 'inspect' && method === 'DELETE') return json({ items: await unassignBin(env, user, rental, Number(m[2])) });
    } catch (err) {
      if (err.status) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = match(/^\/rentals\/(\d+)\/counted$/)) && method === 'POST') {
    return json({ rental: await recordReturnedCount(env, user, Number(m[1]), body) });
  }

  if ((m = match(/^\/rentals\/(\d+)\/extensions$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') return json({ extensions: await listExtensions(env, rid) });
    if (method === 'POST') { requireOwner(user, 'extend a rental'); return json({ extensions: await extendRental(env, user, rid, body) }, 201); }
  }

  /* Diagnostic: the invoice exactly as Square holds it. Read-only, owner only.
     Guessing at why a charge did not fire has cost more than one attempt. */
  if ((m = match(/^\/rentals\/(\d+)\/invoice-raw$/)) && method === 'GET') {
    requireOwner(user);
    const row = await env.DB.prepare('SELECT square_invoice_id, square_card_id, square_customer_id FROM rentals WHERE id = ?1')
      .bind(Number(m[1])).first();
    if (!row?.square_invoice_id) throw new HttpError(404, 'no invoice on this rental');
    try {
      const invoice = await fetchInvoice(env, row.square_invoice_id);
      return json({
        stored: row,
        status: invoice.status,
        delivery_method: invoice.delivery_method,
        payment_requests: invoice.payment_requests,
        accepted_payment_methods: invoice.accepted_payment_methods,
        store_payment_method_enabled: invoice.store_payment_method_enabled,
        next_payment_amount_money: invoice.next_payment_amount_money,
        scheduled_at: invoice.scheduled_at,
        created_at: invoice.created_at,
        updated_at: invoice.updated_at,
      });
    } catch (err) {
      return json({ error: err.message, detail: err.detail }, 400);
    }
  }

  if ((m = match(/^\/rentals\/(\d+)\/sync$/)) && method === 'POST') {
    return json({ rental: await syncRental(env, user, Number(m[1])) });
  }

  if (path === '/employees') {
    if (method === 'GET') {
      requireOwner(user, 'see the staff list');
      const { results } = await env.DB.prepare(
        'SELECT id, email, name, role, active, created_at, created_by, last_seen_at FROM employees ORDER BY active DESC, role, email',
      ).all();
      return json({ employees: results, domain: env.ALLOWED_EMAIL_DOMAIN });
    }
    if (method === 'POST') {
      requireOwner(user, 'add to the staff list');
      return json({ employee: await addEmployee(env, user, body) }, 201);
    }
  }

  if ((m = match(/^\/employees\/(\d+)$/)) && method === 'PATCH') {
    requireOwner(user, 'change the staff list');
    return json({ employee: await updateEmployee(env, user, Number(m[1]), body) });
  }

  if ((m = match(/^\/(requests|rentals|customers)\/(\d+)\/notes$/))) {
    const entity = m[1].slice(0, -1);
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

  if (path === '/schedule' && method === 'GET') {
    const from = url.searchParams.get('from') || today();
    const days = Math.min(60, Math.max(1, parseInt(url.searchParams.get('days') || '1', 10)));
    return json({ from, days: await schedule(env, from, days) });
  }

  if (path === '/inventory' && method === 'GET') {
    const from = url.searchParams.get('from') || today();
    const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
    return json(await availability(env, from, days));
  }

  if (path === '/settings') {
    if (method === 'GET') return json(await getSettings(env));
    if (method === 'PATCH') {
      requireOwner(user);
      const numbers = { turnaround_days: 'turnaroundDays', lead_days: 'leadDays', jobs_per_slot: 'jobsPerSlot', slot_minutes: 'slotMinutes' };
      const texts = { default_window: 'defaultWindow' };
      const put = async (key, value) => {
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_by) VALUES (?1,?2,?3)
           ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
        ).bind(key, value, user.email).run();
        await audit(env, user.email, 'settings.update', 'settings', 0, `${key}=${value}`);
      };
      for (const [key, field] of Object.entries(numbers)) {
        if (!(field in body)) continue;
        const n = parseInt(body[field], 10);
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, `${field} must be a whole number.`);
        await put(key, String(n));
      }
      if ('closedHolidays' in body) {
        const known = new Set(HOLIDAYS.map(h => h.key));
        const keys = [...new Set((Array.isArray(body.closedHolidays) ? body.closedHolidays : []).map(String).filter(k => known.has(k)))];
        await put('closed_holidays', keys.join(','));
      }
      if ('closedWeekdays' in body) {
        const days = [...new Set((Array.isArray(body.closedWeekdays) ? body.closedWeekdays : []).map(Number)
          .filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
        if (days.length === 7) throw new HttpError(400, 'That would close every day of the week.');
        await put('closed_weekdays', days.join(','));
      }
      for (const [key, field] of Object.entries(texts)) {
        if (!(field in body)) continue;
        const v = clean(body[field], 40);
        if (!v) throw new HttpError(400, `${field} cannot be blank.`);
        await put(key, v);
      }
      return json(await getSettings(env));
    }
  }

  /* ---------- customers ----------
     One row per person, with everything they have asked for or rented. The
     list answers "have we dealt with them" and "who should we call in
     March"; the record is where a declined or lapsed enquiry ends up. */
  if (path === '/customers' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const filter = url.searchParams.get('filter') || 'all';
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.email, c.phone, c.first_name, c.last_name, c.city, c.created_at,
         (SELECT COUNT(*) FROM rentals r WHERE r.customer_id = c.id AND r.status != 'cancelled') AS rentals,
         (SELECT COUNT(*) FROM rentals r WHERE r.customer_id = c.id AND r.inspected_at IS NOT NULL) AS finished,
         (SELECT COALESCE(SUM(total_cents), 0) FROM rentals r WHERE r.customer_id = c.id AND r.paid_at IS NOT NULL) AS spent_cents,
         (SELECT COUNT(*) FROM requests q WHERE q.customer_id = c.id) AS requests,
         (SELECT COUNT(*) FROM requests q WHERE q.customer_id = c.id AND q.status = 'new') AS open_requests,
         (SELECT COUNT(*) FROM requests q WHERE q.customer_id = c.id AND q.status = 'declined') AS declined,
         (SELECT COUNT(*) FROM requests q WHERE q.customer_id = c.id AND q.status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('${today()}')) AS lapsed,
         (SELECT MAX(x) FROM (SELECT MAX(created_at) AS x FROM requests q WHERE q.customer_id = c.id
                              UNION ALL SELECT MAX(created_at) FROM rentals r WHERE r.customer_id = c.id)) AS last_seen
       FROM customers c ORDER BY last_seen DESC, c.id DESC LIMIT 500`,
    ).all();
    const customers = results.filter(c => {
      if (filter === 'renters' && !c.finished) return false;
      if (filter === 'declined' && !c.declined) return false;
      if (filter === 'lapsed' && !c.lapsed) return false;
      if (q) {
        const hay = [c.first_name, c.last_name, c.email, c.phone, c.city].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q) && !(c.phone || '').includes(q.replace(/\D/g, '') || '\u0000')) return false;
      }
      return true;
    });
    return json({ customers });
  }
  if ((m = match(/^\/customers\/(\d+)$/))) {
    const cid = Number(m[1]);
    const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?1').bind(cid).first();
    if (!customer) throw new HttpError(404, 'no such customer');
    if (method === 'GET') {
      const { results: requests } = await env.DB.prepare(
        `SELECT ${REQUEST_COLUMNS()} FROM requests WHERE customer_id = ?1 ORDER BY created_at DESC`).bind(cid).all();
      const { results: rentals } = await env.DB.prepare(
        `SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE customer_id = ?1 ORDER BY start_date DESC, id DESC`).bind(cid).all();
      return json({ customer, requests, rentals });
    }
    if (method === 'PATCH') {
      requireOwner(user, 'change a customer\'s details');
      const patch = {};
      if ('email' in body) {
        const e = body.email ? emailKey(body.email) : null;
        if (body.email && !e) throw new HttpError(400, 'That email address looks wrong.');
        patch.email = e;
      }
      if ('phone' in body) {
        const ph = body.phone ? phoneKey(body.phone) : null;
        if (body.phone && !ph) throw new HttpError(400, 'A phone number is ten digits.');
        patch.phone = ph;
      }
      for (const f of ['first_name', 'last_name', 'city']) if (f in body) patch[f] = clean(body[f], 120);
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');
      const keys = Object.keys(patch);
      try {
        await env.DB.prepare(`UPDATE customers SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(', ')},
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?${keys.length + 1} WHERE id = ?${keys.length + 2}`)
          .bind(...keys.map(k => patch[k]), user.email, cid).run();
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'Another customer already has that email address.');
        throw err;
      }
      await audit(env, user.email, 'customer.update', 'customer', cid, keys.join(', '));
      return json({ customer: await env.DB.prepare('SELECT * FROM customers WHERE id = ?1').bind(cid).first() });
    }
  }

  /* When people can drive. Anyone sets their own; an owner sets anyone's. */
  if (path === '/shifts') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT s.id, s.employee_id, e.name, s.weekday, s.date, s.start_time AS start, s.end_time AS end, s.off, s.note, s.created_by
         FROM shifts s JOIN employees e ON e.id = s.employee_id
         WHERE (s.date IS NULL OR s.date >= ?1) AND (?2 = 'owner' OR s.employee_id = ?3)
         ORDER BY e.name, s.weekday, s.date`,
      ).bind(addDays(today(), -7), user.role, user.id).all();
      return json({ shifts: results });
    }
    if (method === 'POST') {
      const eid = Number(body.employee_id);
      if (eid !== user.id) requireOwner(user);
      const emp = await env.DB.prepare('SELECT id, name FROM employees WHERE id = ?1 AND active = 1').bind(eid).first();
      if (!emp) throw new HttpError(404, 'no such employee');
      const weekday = body.weekday === undefined || body.weekday === null || body.weekday === '' ? null : Number(body.weekday);
      const date = body.date ? isoDate(body.date) : null;
      if ((weekday === null) === (date === null)) throw new HttpError(400, 'A shift is either a weekday pattern or a specific date.');
      if (weekday !== null && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) throw new HttpError(400, 'Weekday is 0 (Sunday) to 6 (Saturday).');
      if (body.date && !date) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
      const off = !!body.off;
      let start = null, end = null;
      if (!off) {
        start = String(body.start || '').trim(); end = String(body.end || '').trim();
        if (!isTime(start) || !isTime(end)) throw new HttpError(400, 'Times are HH:MM, like 17:00.');
        if (end <= start) throw new HttpError(400, 'The shift has to end after it starts.');
      }
      // One pattern per person per weekday; one one-off per person per date.
      await env.DB.prepare(
        `DELETE FROM shifts WHERE employee_id = ?1 AND ((?2 IS NOT NULL AND weekday = ?2) OR (?3 IS NOT NULL AND date = ?3))`,
      ).bind(eid, weekday, date).run();
      const res = await env.DB.prepare(
        `INSERT INTO shifts (employee_id, weekday, date, start_time, end_time, off, note, created_by) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      ).bind(eid, weekday, date, start, end, off ? 1 : 0, clean(body.note, 120), user.email).run();
      await audit(env, user.email, 'shift.set', 'employee', eid,
        `${emp.name}: ${date || ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][weekday] + 's'} ${off ? 'off' : `${start}–${end}`}`);
      return json({ id: res.meta.last_row_id }, 201);
    }
  }
  if ((m = match(/^\/shifts\/(\d+)$/)) && method === 'DELETE') {
    const row = await env.DB.prepare('SELECT id, employee_id FROM shifts WHERE id = ?1').bind(Number(m[1])).first();
    if (!row) throw new HttpError(404, 'no such shift');
    if (row.employee_id !== user.id) requireOwner(user);
    await env.DB.prepare('DELETE FROM shifts WHERE id = ?1').bind(row.id).run();
    await audit(env, user.email, 'shift.remove', 'employee', row.employee_id, String(row.id));
    return json({ ok: true });
  }

  if (path === '/coverage' && method === 'GET') {
    const from = url.searchParams.get('from') || today();
    const days = Math.min(62, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
    return json({ from, days: await coverage(env, from, days) });
  }

  /* Days off. Adding one reports any pending job already on that day rather
     than quietly leaving it there. */
  if (path === '/blackouts') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT date, reason, created_by FROM blackouts WHERE date >= ?1 ORDER BY date').bind(addDays(today(), -30)).all();
      return json({ blackouts: results });
    }
    if (method === 'POST') {
      requireOwner(user, 'add a day off');
      // One day, or a run of them — a week away is one entry, not seven.
      const from = isoDate(body.date || body.from);
      const to = isoDate(body.to) || from;
      if (!from) throw new HttpError(400, 'A date is required.');
      if (to < from) throw new HttpError(400, 'The end is before the start.');
      if (dayDiff(to, from) > 90) throw new HttpError(400, 'That is more than 90 days — add it in pieces, or close a weekday.');
      const reason = clean(body.reason, 80);
      const dates = [];
      for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
      for (const date of dates) {
        await env.DB.prepare('INSERT OR REPLACE INTO blackouts (date, reason, created_by) VALUES (?1,?2,?3)')
          .bind(date, reason, user.email).run();
      }
      await audit(env, user.email, 'blackout.add', 'blackout', 0,
        `${from}${to !== from ? ` → ${to}` : ''}${reason ? ` — ${reason}` : ''}`);
      const { results } = await env.DB.prepare(
        `SELECT id, first_name, last_name, start_date, due_date,
                CASE WHEN start_date BETWEEN ?1 AND ?2 THEN 'deliver' ELSE 'collect' END AS job
         FROM rentals WHERE status NOT IN ('cancelled','returned')
           AND (start_date BETWEEN ?1 AND ?2 OR (due_date BETWEEN ?1 AND ?2 AND delivered_at IS NOT NULL))
         ORDER BY start_date`,
      ).bind(from, to).all();
      return json({ ok: true, days: dates.length, affected: results.map(r => ({
        id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' '), job: r.job,
        date: r.job === 'deliver' ? r.start_date : r.due_date })) }, 201);
    }
  }
  if ((m = match(/^\/blackouts\/(\d{4}-\d{2}-\d{2})$/)) && method === 'DELETE') {
    requireOwner(user);
    await env.DB.prepare('DELETE FROM blackouts WHERE date = ?1').bind(m[1]).run();
    await audit(env, user.email, 'blackout.remove', 'blackout', 0, m[1]);
    return json({ ok: true });
  }

  if (path === '/holidays' && method === 'GET') {
    const year = parseInt(url.searchParams.get('year') || today().slice(0, 4), 10);
    return json({ year, holidays: holidaysIn(year) });
  }

  if (path === '/reminders/run' && method === 'POST') {
    requireOwner(user);
    return json(await sendReminders(env));
  }

  /* The inventory. Bins, dollies, hand trucks — anything with a label on it.
     Added in batches because nobody types a hundred rows, but each item exists
     on its own so condition and cost attach to a specific one.

     `kind` is free text, normalised, so a new sort of equipment is a word
     typed into the panel rather than a deploy. `bin` is the one kind the rest
     of the system knows about: it is what packages are sold in, and what §4
     prices. */
  if (path === '/items') {
    if (method === 'GET') {
      const cond = url.searchParams.get('condition');
      const kind = itemKind(url.searchParams.get('kind'));
      const where = [];
      const binds = [];
      if (cond && cond !== 'all') { binds.push(cond); where.push(`condition = ?${binds.length}`); }
      if (kind && kind !== 'all') { binds.push(kind); where.push(`kind = ?${binds.length}`); }
      const { results } = await env.DB.prepare(
        `SELECT id, kind, label, condition, notes, acquired_on, cost_cents,
                flagged_rental_id, created_at, updated_at, updated_by
         FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY kind = 'bin' DESC, kind, label LIMIT 2000`,
      ).bind(...binds).all();
      // Where each one is tonight, and a filter for it.
      const out = await whereabouts(env);
      const where_ = url.searchParams.get('where');
      const listed = results
        .map(i => ({ ...i, out_with: out[i.id] || null }))
        .filter(i => where_ === 'out' ? i.out_with : where_ === 'in' ? !i.out_with : true);
      // Counts are for the whole list, not the filtered view: the tiles and the
      // kind tabs need to know what exists even while one slice is showing.
      const { results: counts } = await env.DB.prepare(
        'SELECT kind, condition, COUNT(*) AS n FROM items GROUP BY kind, condition').all();
      const byKind = {};
      for (const c of counts) {
        byKind[c.kind] ??= { total: 0 };
        byKind[c.kind][c.condition] = c.n;
        byKind[c.kind].total += c.n;
      }
      return json({ items: listed, kinds: byKind, out: Object.keys(out).length });
    }

    if (method === 'POST') {
      requireOwner(user);
      const kind = itemKind(body.kind) || 'bin';
      const count = parseInt(body.count, 10);
      const prefix = (clean(body.prefix, 12) || DEFAULT_PREFIX[kind] || kind.slice(0, 2)).toUpperCase();
      const pad = Math.max(1, Math.min(6, parseInt(body.pad, 10) || 3));
      if (!Number.isFinite(count) || count < 1 || count > 500) {
        throw new HttpError(400, 'Add between 1 and 500 at a time.');
      }

      // Continue the numbering rather than restart it, so a second batch does
      // not collide with the first.
      const { last } = await env.DB.prepare(
        `SELECT MAX(CAST(substr(label, ?1) AS INTEGER)) AS last FROM items WHERE label LIKE ?2`,
      ).bind(prefix.length + 2, `${prefix}-%`).first();
      let next = (last || 0) + 1;

      const cost = body.cost_each ? Math.round(parseFloat(String(body.cost_each).replace(/[^\d.]/g, '')) * 100) : null;
      const acquired = clean(body.acquired_on, 10);
      const made = [];
      for (let n = 0; n < count; n++) {
        const label = `${prefix}-${String(next++).padStart(pad, '0')}`;
        try {
          await env.DB.prepare(
            `INSERT INTO items (kind, label, acquired_on, cost_cents, created_by) VALUES (?1,?2,?3,?4,?5)`,
          ).bind(kind, label, acquired, cost, user.email).run();
          made.push(label);
        } catch {
          // A label already in use just means the run continues past it.
          n--;
        }
      }
      await audit(env, user.email, 'items.add', 'item', 0,
        `${made.length} ${kind}${made.length === 1 ? '' : 's'} (${made[0]}–${made.at(-1)})`);
      return json({ added: made.length, first: made[0], last: made.at(-1) }, 201);
    }
  }

  if ((m = match(/^\/items\/(\d+)$/))) {
    const iid = Number(m[1]);
    if (method === 'PATCH') {
      const row = await env.DB.prepare('SELECT id, kind, label, condition FROM items WHERE id = ?1')
        .bind(iid).first();
      if (!row) throw new HttpError(404, 'no such item');
      const condition = ['good', 'damaged', 'retired', 'lost'].includes(body.condition)
        ? body.condition : row.condition;
      await env.DB.prepare(
        `UPDATE items SET condition = ?1, notes = coalesce(?2, notes),
           flagged_rental_id = ?3,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?4
         WHERE id = ?5`,
      ).bind(condition, clean(body.notes, 500),
             body.rental_id ? Number(body.rental_id) : null, user.email, iid).run();
      if (condition !== row.condition) {
        await audit(env, user.email, 'item.condition', 'item', iid,
          `${row.label}: ${row.condition} → ${condition}${body.notes ? ` — ${clean(body.notes, 120)}` : ''}`);
      }
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      requireOwner(user);
      const row = await env.DB.prepare('SELECT label FROM items WHERE id = ?1').bind(iid).first();
      if (!row) throw new HttpError(404, 'no such item');
      await env.DB.prepare('DELETE FROM items WHERE id = ?1').bind(iid).run();
      await audit(env, user.email, 'item.remove', 'item', iid, row.label);
      return json({ ok: true });
    }
  }

  if (path === '/availability' && method === 'GET') {
    const startDate = url.searchParams.get('start');
    const dueDate = url.searchParams.get('due');
    const bins = parseInt(url.searchParams.get('bins') || '0', 10);
    if (!startDate || !dueDate || !bins) throw new HttpError(400, 'start, due and bins are required');
    return json(await canFit(env, { startDate, dueDate, bins,
      excludeRentalId: url.searchParams.get('exclude') ? Number(url.searchParams.get('exclude')) : undefined }));
  }

  if (path === '/audit' && method === 'GET') {
    requireOwner(user, 'see the activity log');
    const { results } = await env.DB.prepare(
      'SELECT at, actor_email, action, entity, entity_id, detail FROM audit_log ORDER BY at DESC LIMIT 100',
    ).all();
    return json({ entries: results });
  }

  throw new HttpError(404, 'no such endpoint');
}

/* Called by the public Worker over a service binding, never over HTTP.

   The Square access token lives here and nowhere else. The confirmation flow
   runs on the public Worker — a customer has no Access session and never should
   — so rather than copying the credential across, that Worker asks this one.
   RPC entrypoints have no URL, so this adds no public surface. */
export class Billing extends WorkerEntrypoint {
  /* Exchange the browser's single-use token for a card stored against the
     customer. Card details never reach either Worker. */
  async storeCardForRental(token, payload) {
    const env = this.env;
    const rental = await env.DB.prepare(
      `SELECT id, first_name, last_name, email, phone, square_customer_id, square_card_id
       FROM rentals WHERE confirm_token = ?1`,
    ).bind(token).first();
    if (!rental) return { ok: false, error: 'no such rental' };
    if (rental.square_card_id) return { ok: true, already: true };

    try {
      const customerId = rental.square_customer_id || await ensureCustomer(env, rental);
      const card = await storeCard(env, {
        customerId,
        sourceId: payload.sourceId,
        verificationToken: payload.verificationToken,
        holderName: payload.holderName,
        postalCode: payload.postalCode,
      });

      await env.DB.prepare(
        `UPDATE rentals SET square_customer_id=?1, square_card_id=?2, card_brand=?3,
           card_last4=?4, card_exp=?5, card_stored_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id=?6`,
      ).bind(customerId, card.id, card.brand, card.last4, card.exp, rental.id).run();

      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind(rental.email || 'customer', 'rental.card_stored', 'rental', String(rental.id),
             `${card.brand || 'card'} ending ${card.last4 || '????'}`).run();

      return { ok: true, brand: card.brand, last4: card.last4 };
    } catch (err) {
      // Square's message is the useful one here — an expired card, a declined
      // verification — so it is passed through rather than flattened.
      console.log('storeCard failed', err.message);
      return { ok: false, error: err instanceof SquareError ? err.message : 'That card could not be saved.' };
    }
  }

  /* Raise the invoice and let Square charge the stored card. Called once the
     customer has signed and their card is on file. */
  async chargeRental(token) {
    const env = this.env;
    const rental = await env.DB.prepare(
      `SELECT ${RENTAL_COLUMNS()} FROM rentals WHERE confirm_token = ?1`,
    ).bind(token).first();
    if (!rental) return { ok: false, error: 'no such rental' };
    if (rental.square_invoice_id) return { ok: true, already: true, url: rental.square_invoice_url };
    if (!rental.square_card_id) return { ok: false, error: 'no card on file' };

    try {
      /* Charged now, not on the delivery date. Square bills a card-on-file
         invoice on its due date, and discovering a declined card on the morning
         a driver is loading bins is the worst possible moment to find out. The
         customer has signed by this point, so terms.html's "nothing is charged
         until we confirm and you sign" is satisfied. */
            const sq = await createInvoice(env, rental, {
        cardId: rental.square_card_id,
        dueDate: today(),
      });
      await env.DB.prepare(
        `UPDATE rentals SET square_customer_id=?1, square_order_id=?2, square_invoice_id=?3,
           square_invoice_url=?4, square_status=?5 WHERE id=?6`,
      ).bind(sq.square_customer_id, sq.square_order_id, sq.square_invoice_id,
             sq.square_invoice_url, sq.square_status, rental.id).run();

      await env.DB.prepare(
        'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
      ).bind('system', 'rental.invoice_auto', 'rental', String(rental.id), sq.square_invoice_id).run();

      return { ok: true, url: sq.square_invoice_url, status: sq.square_status };
    } catch (err) {
      console.log('chargeRental failed', err.message);
      return { ok: false, error: err instanceof SquareError ? err.message : 'The payment could not be taken.' };
    }
  }
}

export default {
  /* Retention runs itself. Anything that depends on someone remembering to run
     it is a promise the business will eventually break. */
  /* Two crons. 09:00 UTC (small hours Mountain) sweeps photos; 15:00 UTC
     (9am Mountain, give or take DST) sends tomorrow's reminders — late
     enough to be read over breakfast, early enough to act on. */
  async scheduled(event, env, ctx) {
    if (event.cron === '0 15 * * *') {
      ctx.waitUntil(sendReminders(env).then(
        r => console.log('reminders sent', r.sent, 'for', r.for),
        err => console.log('reminders failed', err.message),
      ));
      return;
    }
    ctx.waitUntil(sweepPhotos(env).then(
      r => console.log('photo retention swept', r.deleted),
      err => console.log('photo retention failed', err.message),
    ));
  },

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
