-- Beehive Bin Co. — initial admin backend schema.
-- Applied to the D1 database `beehive` (see workers/admin/wrangler.toml).

-- Inbound submissions from beehivebin.co. A request is a *lead*: it becomes a
-- rental only once approved, signed, and paid. Keeping them separate means a
-- declined or duplicate request never pollutes the operational view.
CREATE TABLE IF NOT EXISTS requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  kind               TEXT NOT NULL,                 -- reserve | contact
  status             TEXT NOT NULL DEFAULT 'new',   -- new | approved | declined | converted
  -- customer
  first_name         TEXT,
  last_name          TEXT,
  email              TEXT,
  phone              TEXT,
  -- rental shape (reserve only)
  bins               INTEGER,
  weeks              INTEGER,
  start_date         TEXT,                          -- ISO yyyy-mm-dd
  return_date        TEXT,                          -- display string from the form
  quoted_total_cents INTEGER,
  delivery_city      TEXT,
  pickup_city        TEXT,
  -- free text
  customer_notes     TEXT,                          -- the reserve form's notes textarea
  message            TEXT,                          -- the contact form's message
  internal_notes     TEXT,
  -- decision
  decided_at         TEXT,
  decided_by         TEXT,
  decline_reason     TEXT,
  -- everything the columns above don't model, verbatim
  raw_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_start   ON requests(start_date);

-- Who may sign in to admin.beehivebin.co. Cloudflare Access proves *identity*
-- (the email is real and verified); this table decides *authorization*.
-- Anyone with an @beehivebin.co mailbox is allowed implicitly and auto-enrolled
-- on first sign-in, so the table can never lock the owner out of their own panel.
CREATE TABLE IF NOT EXISTS employees (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'staff',  -- owner | staff
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by   TEXT,
  last_seen_at TEXT
);

-- Append-only. Answers "who approved this and when" months later, when nobody
-- remembers. Never updated or deleted by application code.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,   -- request.approve, employee.add, ...
  entity      TEXT,            -- request | employee
  entity_id   TEXT,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
