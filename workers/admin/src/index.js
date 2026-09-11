/* Beehive Bin Co. — admin backend (admin.beehivebin.co).

   Cloudflare Access proves who the visitor is; this Worker decides what they
   may do and serves the panel. Static files come from ./public; everything
   under /api is handled here. */

import { verifyAccessJwt } from './auth.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createInvoice, fetchInvoice, ping as squarePing, storeCard, ensureCustomer, SquareError } from './square.js';
import { PRICES, EXTRA, quoteCents } from './pricing.js';
import { rateFor } from './tax.js';

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

const REQUEST_COLUMNS = `id, created_at, kind, source, status, contact_pref,
  CASE WHEN status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('now')
       THEN 1 ELSE 0 END AS lapsed, first_name, last_name, email, phone,
  bins, weeks, start_date, return_date, quoted_total_cents, delivery_city, pickup_city,
  customer_notes, message, internal_notes, decided_at, decided_by, decline_reason`;

const STATUSES = ['new', 'approved', 'declined', 'converted'];

async function listRequests(env, url) {
  const status = url.searchParams.get('status');
  const q = String(url.searchParams.get('q') || '').trim();
  const where = [];
  const binds = [];

  /* A request for a date that has passed is dead — the customer needed bins on
     the 25th and it is the 26th. It is still unhandled work, so it stays in the
     queue, but it must not read as live. Derived rather than stored: a date
     passing should not silently rewrite a record. */
  if (status === 'lapsed') {
    where.push("status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('now')");
  } else if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'unknown status');
    binds.push(status);
    where.push(`status = ?${binds.length}`);
    if (status === 'new') {
      where.push("(start_date IS NULL OR date(start_date) >= date('now'))");
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

  const sql = `SELECT ${REQUEST_COLUMNS} FROM requests
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT 200`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}


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
  CASE WHEN status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('now')
       THEN 1 ELSE 0 END AS stalled,
  photo_hold, delivery_unlocked_at, delivery_unlocked_by,
  pickup_unlocked_at, pickup_unlocked_by,
  signed_on_behalf, agreement_manual, agreement_manual_by,
  agreement_manual_reason, confirm_token, confirm_sent_at, agreement_name, agreement_version, agreement_signed_at AS signed_at,
  square_customer_id, square_order_id, square_invoice_id, square_invoice_url, square_status,
  square_card_id, card_brand, card_last4, card_exp, card_stored_at,
  first_name, last_name, email, phone, contact_pref,
  bins, weeks, start_date, due_date, total_cents,
  delivery_city, delivery_address, delivery_notes, delivery_street, delivery_unit, delivery_zip,
  pickup_city, pickup_address, pickup_notes, pickup_street, pickup_unit, pickup_zip,
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
  } else if (status === 'stalled') {
    // Never confirmed, and the day it was meant to go out has passed.
    where = "WHERE status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('now')";
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
      const today = new Date().toISOString().slice(0, 10);
      if (row.start_date > today && !body.force) {
        const days = Math.round((new Date(row.start_date) - new Date(today)) / 86400000);
        throw new HttpError(423, `This is not due out for ${days} day${days === 1 ? '' : 's'} (${row.start_date}). Mark it delivered anyway?`);
      }
      if (row.start_date > today) {
        const days = Math.round((new Date(row.start_date) - new Date(today)) / 86400000);
        await audit(env, user.email, 'rental.delivered_early', 'rental', id, `${days} day(s) before ${row.start_date}`);
      }
    }

    if (body.done !== false && body.milestone === 'returned' && row.due_date
        && !row.pickup_unlocked_at) {
      const today = new Date().toISOString().slice(0, 10);
      if (row.due_date > today && !body.force) {
        const days = Math.round((new Date(row.due_date) - new Date(today)) / 86400000);
        throw new HttpError(423, `These are not due back for ${days} day${days === 1 ? '' : 's'} (${row.due_date}). Mark them back anyway?`);
      }
      if (row.due_date > today) {
        const days = Math.round((new Date(row.due_date) - new Date(today)) / 86400000);
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
  if ('status' in body) {
    if (!RENTAL_STATUSES.includes(body.status)) throw new HttpError(400, 'unknown status');

    if (body.status === 'cancelled') {
      /* Cancelling a rental whose bins are at someone's house is not a
         cancellation, it is a loose end. And cancelling a paid one without
         saying what happened to the money leaves a customer out of pocket with
         no record of why. */
      if (row.delivered_at && !row.returned_at) {
        throw new HttpError(409, 'These bins are still out. Mark them back before cancelling, or this rental disappears with your bins at a customer\'s house.');
      }
      const why = String(body.reason || '').trim().slice(0, 300);
      if (!why) throw new HttpError(428, 'Why is this being cancelled?');

      if (row.paid_at) {
        await audit(env, user.email, 'rental.cancelled_after_payment', 'rental', id,
          `${why} — refund must be issued in Square`);
      }
      await audit(env, user.email, 'rental.cancel', 'rental', id, why);
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
       pickup_street=?17, pickup_unit=?18, pickup_zip=?19
     WHERE id=?20`,
  ).bind(
    patch.status, patch.agreement_signed_at, patch.paid_at, patch.delivered_at,
    patch.returned_at, patch.delivery_address, patch.pickup_address,
    patch.delivery_city, patch.pickup_city, patch.notes,
    patch.agreement_manual ? 1 : 0, patch.agreement_manual_by, patch.agreement_manual_reason,
    patch.delivery_street, patch.delivery_unit, patch.delivery_zip,
    patch.pickup_street, patch.pickup_unit, patch.pickup_zip,
    id,
  ).run();

  await audit(env, user.email, body.milestone ? `rental.${body.milestone}` : 'rental.update',
    'rental', id, body.milestone ? `done=${body.done !== false}` : null);

  return env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(id).first();
}

/* Starting a rental means giving the customer their link — nothing more.
   The invoice is raised by the confirmation flow once their card is on file,
   because an invoice created before then has no card to charge and Square will
   not attach one afterwards. Creating it here was the reason three attempts at
   automatic payment quietly did nothing. */
async function invoiceRental(env, user, id) {
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(id).first();
  if (!rental) throw new HttpError(404, 'no such rental');
  if (rental.status === 'cancelled') throw new HttpError(400, 'This rental is cancelled.');
  if (!rental.email) throw new HttpError(400, 'This rental has no email address to send to.');

  if (!rental.confirm_token) {
    await env.DB.prepare('UPDATE rentals SET confirm_token = ?1 WHERE id = ?2')
      .bind(crypto.randomUUID(), id).run();
  }

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
      && state?.due_date && state.due_date > new Date().toISOString().slice(0, 10)) {
    throw new HttpError(423, `These are not due back until ${state.due_date}. Unlock the pickup step first if you are collecting early.`);
  }

  if (kind === 'delivery' && !state?.delivered_at && !state?.delivery_unlocked_at
      && state?.start_date && state.start_date > new Date().toISOString().slice(0, 10)) {
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

  /* The photo IS the visit. Someone standing at a door with the bins has
     delivered them; asking them to also tick a box is modelling a database
     rather than a job. So the milestone follows the evidence.

     Prerequisites are recorded, not enforced, here: the bins are already on the
     doorstep. Refusing to mark an unpaid rental delivered after the fact would
     leave the record saying something that is not true. */
  const milestone = kind === 'delivery' ? 'delivered' : 'returned';
  const col = MILESTONES[milestone];
  const current = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
    .bind(rentalId).first();

  if (current && !current[col]) {
    const missing = (PREREQ[milestone] || []).filter(p => !current[p.col]).map(p => p.col);
    const patched = { ...current, [col]: now() };
    await env.DB.prepare(`UPDATE rentals SET ${col} = ?1, status = ?2 WHERE id = ?3`)
      .bind(patched[col], statusFrom(patched), rentalId).run();
    await audit(env, user.email, `rental.${milestone}`, 'rental', rentalId,
      missing.length ? `from photo, without ${missing.join(', ')}` : 'from photo');
  }

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
       AND date(coalesce(r.returned_at, r.due_date)) < date('now', ?1)
     LIMIT 500`,
  ).bind(cutoff).all();

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
  const rental = await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`)
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
      serviceDate: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10),
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

  if (path === '/me' && method === 'GET') return json({ user, booking_host: env.BOOKING_HOST });

  if (path === '/stats' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT status, COUNT(*) AS count FROM requests GROUP BY status',
    ).all();
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of results) counts[r.status] = r.count;

    const { count: lapsed } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM requests WHERE status = 'new' AND start_date IS NOT NULL AND date(start_date) < date('now')",
    ).first();
    counts.lapsed = lapsed;
    counts.new = Math.max(0, counts.new - lapsed);   // the badge should count live work

    const { count: activeRentals } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status IN ('pending','confirmed','out')",
    ).first();
    const { count: overdue } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status = 'out' AND due_date < date('now')",
    ).first();
    const { count: stalled } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rentals WHERE status = 'pending' AND start_date IS NOT NULL AND date(start_date) < date('now')",
    ).first();

    return json({ counts, rentals: { active: activeRentals, overdue, stalled } });
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
      // The panel should quote the same number the customer was shown.
      try {
        const { rate } = rateFor(row.delivery_city, row.start_date);
        row.tax_cents = Math.round((row.total_cents || 0) * parseFloat(rate) / 100);
        row.tax_rate = rate;
      } catch { row.tax_cents = null; }
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
    return json({ rental: await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(rid).first() });
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
    const rid = Number(m[1]);
    await sendConfirmLink(env, user, rid);
    return json({ rental: await env.DB.prepare(`SELECT ${RENTAL_COLUMNS} FROM rentals WHERE id = ?1`).bind(rid).first() });
  }

  if ((m = match(/^\/rentals\/(\d+)\/extensions$/))) {
    const rid = Number(m[1]);
    if (method === 'GET') return json({ extensions: await listExtensions(env, rid) });
    if (method === 'POST') return json({ extensions: await extendRental(env, user, rid, body) }, 201);
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
      `SELECT ${RENTAL_COLUMNS} FROM rentals WHERE confirm_token = ?1`,
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
      const today = new Date().toISOString().slice(0, 10);
      const sq = await createInvoice(env, rental, {
        cardId: rental.square_card_id,
        dueDate: today,
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
  async scheduled(event, env, ctx) {
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
