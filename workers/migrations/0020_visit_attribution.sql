-- Who did the visit, alongside when.
--
-- The timestamps were already there and the audit log had the person, but
-- neither was on the rental itself — so "who dropped these off" meant opening
-- the history and reading backwards. It is the first question asked when a
-- customer says the bins never arrived, or arrived damaged.
ALTER TABLE rentals ADD COLUMN delivered_by TEXT;
ALTER TABLE rentals ADD COLUMN returned_by  TEXT;

-- Backfill from the audit log where it can be worked out.
UPDATE rentals SET delivered_by = (
  SELECT actor_email FROM audit_log
  WHERE entity = 'rental' AND entity_id = CAST(rentals.id AS TEXT)
    AND action = 'rental.delivered' ORDER BY id DESC LIMIT 1)
WHERE delivered_at IS NOT NULL AND delivered_by IS NULL;

UPDATE rentals SET returned_by = (
  SELECT actor_email FROM audit_log
  WHERE entity = 'rental' AND entity_id = CAST(rentals.id AS TEXT)
    AND action = 'rental.returned' ORDER BY id DESC LIMIT 1)
WHERE returned_at IS NOT NULL AND returned_by IS NULL;
