-- Someone other than the named renter signing. A spouse or housemate signing is
-- legitimate and common; what is not acceptable is it happening silently, so
-- that "who agreed to this" cannot be answered later.
ALTER TABLE rentals ADD COLUMN signed_on_behalf INTEGER NOT NULL DEFAULT 0;
