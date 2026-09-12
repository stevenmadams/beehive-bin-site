-- Time of day, and days off.
--
-- The agreement promises "we'll confirm an exact window with you". Until now
-- there was nowhere to write one down, so it lived in text messages. A window
-- is short free text per visit ("6–8pm", "after 5"), defaulted from a setting
-- so most rentals never need it typed.
ALTER TABLE rentals ADD COLUMN delivery_window TEXT;
ALTER TABLE rentals ADD COLUMN pickup_window   TEXT;

-- The day-before reminder, sent once. Null means not yet.
ALTER TABLE rentals ADD COLUMN reminded_delivery_at TEXT;
ALTER TABLE rentals ADD COLUMN reminded_pickup_at   TEXT;

-- Days we do not go out: holidays, a week away. A booking cannot start on
-- one, and the run sheet says why the day is empty.
CREATE TABLE IF NOT EXISTS blackouts (
  date       TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by TEXT NOT NULL
);

-- default_window and lead_days live in `settings` when changed; their
-- defaults live in inventory.js getSettings(), so there is one place to look.
