-- What happens when a rental goes wrong.
--
-- §4 of the rental agreement authorises exactly three charges beyond the rental
-- fee: a late return at the extra-week rate, a missing bin at $15, and damage
-- beyond normal wear at the same $15. Each is a separate, attributed line that
-- someone decided to raise — nothing here charges a card on its own, because
-- the difference between "three days late" and "his mother died" is a judgement
-- call and the card on file makes a wrong one expensive.
--
-- Charges are invoiced separately from the rental. The rental invoice is
-- settled at delivery; this one is raised after the fact against the same card,
-- which is what §4 describes.
CREATE TABLE IF NOT EXISTS charges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id   INTEGER NOT NULL REFERENCES rentals(id),
  kind        TEXT NOT NULL,          -- late | missing | damage | other
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_cents  INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- Utah's treatment of a lost-property charge is a question outstanding with
  -- the Tax Commission (see docs/admin-backend.md). Taxable is the default and
  -- the safer direction to be wrong in; it is per-charge so the answer can be
  -- applied without a migration.
  taxable     INTEGER NOT NULL DEFAULT 1,
  reason      TEXT,                   -- what the customer is told, in words
  -- The evidence. A damage charge that cannot name the bins it is for is a
  -- charge that loses a dispute.
  bin_labels  TEXT,
  square_invoice_id  TEXT,
  square_invoice_url TEXT,
  square_status      TEXT,
  invoiced_at TEXT,
  paid_at     TEXT,
  waived_at   TEXT,                   -- decided against, kept for the record
  waived_by   TEXT,
  waive_reason TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_charges_rental ON charges(rental_id, created_at);
CREATE INDEX IF NOT EXISTS idx_charges_invoice ON charges(square_invoice_id);

-- How many actually came back. Left null until someone counts; a shortfall is
-- what turns into a missing-bin charge, and "we never counted" must be
-- distinguishable from "all of them came back".
ALTER TABLE rentals ADD COLUMN bins_returned INTEGER;
