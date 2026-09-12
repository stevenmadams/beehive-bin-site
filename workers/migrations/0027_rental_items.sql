-- Which bins are on which rental.
--
-- Until now a rental knew how many bins it had and inventory knew how many
-- bins existed, and the two met only in a count someone typed after the
-- pickup. This is the tie: a row per bin per rental, written when they go
-- out (auto-picked from the free ones, or chosen by label) and resolved at
-- inspection — back fine, back damaged, or not back at all.
CREATE TABLE IF NOT EXISTS rental_items (
  rental_id      INTEGER NOT NULL REFERENCES rentals(id),
  item_id        INTEGER NOT NULL REFERENCES items(id),
  assigned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  assigned_by    TEXT NOT NULL,
  back_at        TEXT,              -- resolved at inspection
  back_by        TEXT,
  back_condition TEXT,              -- good | damaged | lost
  back_note      TEXT,
  PRIMARY KEY (rental_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_rental_items_item ON rental_items(item_id);

-- The fifth step. The bins are back (returned_at) and then someone looks at
-- each one and cleans it; that is when damage and loss are found, so that is
-- when they are recorded.
ALTER TABLE rentals ADD COLUMN inspected_at TEXT;
ALTER TABLE rentals ADD COLUMN inspected_by TEXT;
