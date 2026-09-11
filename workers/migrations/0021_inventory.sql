-- Settings the owner can change without a deploy. Starts small deliberately:
-- the fleet size and the turnaround are the two numbers that change how the
-- business plans, and neither belongs in code.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by TEXT
);

-- How many bins exist, and how long they are unavailable after coming back.
-- The site promises bins are "inspected and cleaned between rentals", so a
-- same-evening turnaround is not realistic for sixty of them — but the right
-- number is the owner's to set, not mine to assume.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('fleet_total', '0'),
  ('turnaround_days', '1');

-- Bins out of the pool for a while: damaged, being repaired, lent out, lost.
-- Counted rather than tracked individually — nobody serial-numbers moving bins,
-- and a count is what availability actually needs.
CREATE TABLE IF NOT EXISTS fleet_adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bins       INTEGER NOT NULL,          -- negative removes from the pool, positive adds
  reason     TEXT NOT NULL,
  from_date  TEXT NOT NULL,
  to_date    TEXT,                      -- NULL means indefinitely
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fleet_adj_dates ON fleet_adjustments(from_date, to_date);
