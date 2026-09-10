-- Extra weeks on a rental already under way.
--
-- The agreement sells them at $25–$90 depending on package, but a rental was
-- invoiced once and never again — so a customer keeping the bins a third week
-- either got it free or got an invoice raised by hand in Square, outside
-- everything that records what happened.
--
-- A table rather than columns: a rental can be extended more than once, and
-- each extension is separately invoiced, separately paid and separately taxed.
CREATE TABLE IF NOT EXISTS rental_extensions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id          INTEGER NOT NULL REFERENCES rentals(id),
  weeks              INTEGER NOT NULL,
  amount_cents       INTEGER NOT NULL,
  -- What the due date was and what it became, so the history reads as a
  -- sequence rather than needing to be recomputed from the current value.
  previous_due_date  TEXT NOT NULL,
  new_due_date       TEXT NOT NULL,
  reason             TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by         TEXT NOT NULL,
  -- Its own invoice. The original is already paid and settled; adding to it
  -- would rewrite a document the customer has.
  square_order_id    TEXT,
  square_invoice_id  TEXT,
  square_invoice_url TEXT,
  square_status      TEXT,
  paid_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_ext_rental  ON rental_extensions(rental_id, created_at);
-- The webhook finds its way back from Square's invoice id alone.
CREATE INDEX IF NOT EXISTS idx_ext_invoice ON rental_extensions(square_invoice_id);
