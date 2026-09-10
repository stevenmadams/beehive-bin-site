/* Beehive Bin Co. — admin backend (admin.beehivebin.co).

   Cloudflare Access proves who the visitor is; this Worker decides what they
   may do and serves the panel. Static files come from ./public; everything
   under /api is handled here. */

import { verifyAccessJwt } from './auth.js';

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

  const existing = await env.DB.prepare('SELECT id, status FROM requests WHERE id = ?1')
    .bind(id).first();
  if (!existing) throw new HttpError(404, 'no such request');

  const status = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'new';
  const reason = action === 'decline' ? String(body.reason || '').trim().slice(0, 500) || null : null;
  const decidedAt = action === 'reopen' ? null : new Date().toISOString().replace(/\.\d+/, '');
  const decidedBy = action === 'reopen' ? null : user.email;

  await env.DB.prepare(
    'UPDATE requests SET status = ?1, decided_at = ?2, decided_by = ?3, decline_reason = ?4 WHERE id = ?5',
  ).bind(status, decidedAt, decidedBy, reason, id).run();
  await audit(env, user.email, `request.${action}`, 'request', id, reason);

  return env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?1`).bind(id).first();
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

/* ---------- router ---------- */

async function api(request, env, url) {
  const user = await authenticate(request, env);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  const body = ['POST', 'PATCH', 'PUT'].includes(method)
    ? await request.json().catch(() => { throw new HttpError(400, 'bad JSON body'); })
    : {};

  const match = re => re.exec(path);
  let m;

  if (path === '/me' && method === 'GET') return json({ user });

  if (path === '/stats' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT status, COUNT(*) AS count FROM requests GROUP BY status',
    ).all();
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of results) counts[r.status] = r.count;
    return json({ counts });
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
    return json({ request: await decideRequest(env, user, Number(m[1]), body) });
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
