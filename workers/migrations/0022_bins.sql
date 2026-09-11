-- The actual inventory: one row per bin.
--
-- An earlier attempt modelled this as a single "how many do you own" number
-- with availability computed from it. That answered "can I take this booking"
-- but could not answer "which bin came back cracked", which is the question
-- behind the $15 replacement charge in §4 of the agreement.
--
-- Bins are added in batches because nobody types a hundred rows, but they exist
-- individually so condition, cost and history attach to a specific bin.
CREATE TABLE IF NOT EXISTS bins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE,          -- what is written on the bin
  condition   TEXT NOT NULL DEFAULT 'good',  -- good | damaged | retired | lost
  notes       TEXT,
  acquired_on TEXT,
  cost_cents  INTEGER,
  -- Set when a bin is known to be damaged on a particular rental, so a charge
  -- can point at the bin and the rental it came back from.
  flagged_rental_id INTEGER REFERENCES rentals(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by  TEXT NOT NULL,
  updated_at  TEXT,
  updated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_bins_condition ON bins(condition, label);

-- fleet_total is no longer a setting: the fleet is however many usable bins are
-- on the list. A number typed in one place and a list kept in another will
-- disagree, and the list is the one people maintain.
DELETE FROM settings WHERE key = 'fleet_total';
DROP TABLE IF EXISTS fleet_adjustments;
