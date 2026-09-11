-- Same treatment for the return as the delivery. Two cards that look identical
-- should behave identically; an inconsistency there costs more than the rule
-- itself does.
ALTER TABLE rentals ADD COLUMN pickup_unlocked_at TEXT;
ALTER TABLE rentals ADD COLUMN pickup_unlocked_by TEXT;
