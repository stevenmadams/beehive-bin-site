-- Addresses as parts rather than one free-text line.
--
-- A single box could not be trusted: someone selects Bountiful on the booking
-- form and types an Ogden street, and the invoice is taxed at the wrong rate.
-- It also cannot be formatted for a run sheet, sorted by area, or checked.
--
-- `delivery_address` / `pickup_address` stay as the composed one-line form for
-- display and for the records written before this change; the parts are what
-- gets edited from here on.
ALTER TABLE rentals ADD COLUMN delivery_street TEXT;
ALTER TABLE rentals ADD COLUMN delivery_unit   TEXT;
ALTER TABLE rentals ADD COLUMN delivery_zip    TEXT;
ALTER TABLE rentals ADD COLUMN pickup_street   TEXT;
ALTER TABLE rentals ADD COLUMN pickup_unit     TEXT;
ALTER TABLE rentals ADD COLUMN pickup_zip      TEXT;
