-- Inventory is more than bins: dollies, hand trucks, whatever else goes out on
-- a job. Same row shape — a label on the thing, its condition, what it cost —
-- so the table is renamed rather than duplicated, and `kind` says what it is.
--
-- `bin` stays special in two places, deliberately: the bookable fleet counts
-- only bins, because packages are sold in bins; and §4 of the agreement prices
-- only bins, so a damaged dolly is flagged for a human rather than charged at
-- a rate the customer never agreed to.
ALTER TABLE bins RENAME TO items;
ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'bin';

DROP INDEX IF EXISTS idx_bins_condition;
CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind, condition, label);
CREATE INDEX IF NOT EXISTS idx_items_flagged ON items(flagged_rental_id);
