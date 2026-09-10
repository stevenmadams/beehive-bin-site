-- Square linkage on a rental. Stored on the rental rather than the request
-- because the invoice is raised against agreed terms, not against an enquiry.
ALTER TABLE rentals ADD COLUMN square_customer_id TEXT;
ALTER TABLE rentals ADD COLUMN square_order_id    TEXT;
ALTER TABLE rentals ADD COLUMN square_invoice_id  TEXT;
ALTER TABLE rentals ADD COLUMN square_invoice_url TEXT;   -- customer-facing payment page
ALTER TABLE rentals ADD COLUMN square_status      TEXT;   -- DRAFT | UNPAID | PAID | CANCELED ...

-- The webhook arrives on the public forms Worker and has to find the rental it
-- refers to using only Square's invoice id.
CREATE INDEX IF NOT EXISTS idx_rentals_sq_invoice ON rentals(square_invoice_id);

-- Every webhook Square sends, recorded before it is acted on. Square retries on
-- failure, so the delivery id is the dedupe key: a retried payment notification
-- must not tick "paid" twice or overwrite a later correction.
CREATE TABLE IF NOT EXISTS square_events (
  event_id    TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  type        TEXT,
  invoice_id  TEXT,
  handled     INTEGER NOT NULL DEFAULT 0,
  body        TEXT
);
