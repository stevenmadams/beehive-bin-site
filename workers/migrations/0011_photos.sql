-- Proof of condition at each end of a rental.
--
-- The agreement charges $15 per bin for damage beyond normal wear, and the
-- dispute is always "they were already like that". A delivery photo alone
-- proves nothing about what came back, and a pickup photo alone has no
-- baseline — only the pair makes a charge defensible.
--
-- The image itself lives in R2; this table is the index. Storing the key rather
-- than a URL means the bucket can move without rewriting rows.
CREATE TABLE IF NOT EXISTS rental_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rental_id    INTEGER NOT NULL REFERENCES rentals(id),
  kind         TEXT NOT NULL,              -- delivery | pickup
  r2_key       TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  taken_by     TEXT NOT NULL,              -- employee email
  taken_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  caption      TEXT,
  -- Photos are taken on a customer's property and show their door. They are
  -- kept while they could still matter and then removed; this records when that
  -- happened rather than letting rows quietly disappear.
  deleted_at   TEXT,
  deleted_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_photos_rental ON rental_photos(rental_id, kind, taken_at DESC);
