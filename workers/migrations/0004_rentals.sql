-- A rental is what a request becomes once we have said yes. It is a separate
-- record, not a status on the request, because the two have different
-- lifecycles: a request is answered once, a rental is worked for weeks.
--
-- Customer and terms are copied in rather than joined. A rental is the
-- operational record of what was actually agreed; later edits to the originating
-- request must not silently rewrite what a driver is delivering tomorrow.
CREATE TABLE IF NOT EXISTS rentals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id          INTEGER REFERENCES requests(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by          TEXT,

  -- pending -> confirmed -> out -> returned, or cancelled from anywhere.
  -- Kept explicit rather than derived so "cancelled" has somewhere to live;
  -- the API is the only thing that writes it, alongside the timestamps below.
  status              TEXT NOT NULL DEFAULT 'pending',

  -- customer, as agreed
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT,
  phone               TEXT,
  contact_pref        TEXT,

  -- terms
  bins                INTEGER,
  weeks               INTEGER,
  start_date          TEXT,        -- delivery day, ISO yyyy-mm-dd
  due_date            TEXT,        -- pickup day, ISO yyyy-mm-dd
  total_cents         INTEGER,

  -- where. City comes from the request; the street address is collected later,
  -- which is why the run sheet cannot be built from requests alone.
  delivery_city       TEXT,
  delivery_address    TEXT,
  pickup_city         TEXT,
  pickup_address      TEXT,

  -- the manual Square steps, as timestamps so "when" survives as well as "whether"
  agreement_signed_at TEXT,
  paid_at             TEXT,

  -- operations
  delivered_at        TEXT,
  returned_at         TEXT,

  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status, start_date);
CREATE INDEX IF NOT EXISTS idx_rentals_start  ON rentals(start_date);
CREATE INDEX IF NOT EXISTS idx_rentals_due    ON rentals(due_date);
CREATE INDEX IF NOT EXISTS idx_rentals_req    ON rentals(request_id);
