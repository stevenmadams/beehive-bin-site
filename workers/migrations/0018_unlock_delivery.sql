-- Opening the delivery step before its date.
--
-- The lock is a guard against ticking the wrong rental, not a state of the
-- world, but it has to be recorded: the photo upload is blocked server-side
-- too, so "unlocked" cannot live only in one browser tab. It also answers why a
-- rental was marked delivered four days early.
ALTER TABLE rentals ADD COLUMN delivery_unlocked_at TEXT;
ALTER TABLE rentals ADD COLUMN delivery_unlocked_by TEXT;
