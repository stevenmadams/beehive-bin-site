-- Delivery and pickup are two different visits and can have nothing in common:
-- dropped at a house with a gate code, collected from a storage unit across
-- town. One notes field made the second visit guess.
ALTER TABLE rentals ADD COLUMN delivery_notes TEXT;
ALTER TABLE rentals ADD COLUMN pickup_notes   TEXT;

-- `notes` stays, but is now staff-only. It was previously written by both the
-- customer's confirmation page and the panel, so a customer correcting their
-- address would overwrite whatever a driver had been told.
UPDATE rentals SET delivery_notes = notes WHERE delivery_notes IS NULL AND notes IS NOT NULL;
