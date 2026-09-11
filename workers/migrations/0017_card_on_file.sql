-- A card actually stored against the customer in Square.
--
-- §3 of the agreement requires one "for the duration of the rental" and §4
-- authorises charging it for late returns and damage without a further
-- signature. Nothing enforced that: the invoice checkout only ever offered a
-- "save my card" checkbox the customer could decline, so the authorisation
-- could be signed with no card behind it.
--
-- Card details never reach us. Square's Web Payments SDK tokenises in the
-- customer's browser; we exchange the single-use token for a stored card and
-- keep only its id and the last four digits, which is what a human needs to
-- recognise it on a receipt.
ALTER TABLE rentals ADD COLUMN square_card_id     TEXT;
ALTER TABLE rentals ADD COLUMN card_brand         TEXT;
ALTER TABLE rentals ADD COLUMN card_last4         TEXT;
ALTER TABLE rentals ADD COLUMN card_exp           TEXT;   -- MM/YYYY, for spotting one about to lapse
ALTER TABLE rentals ADD COLUMN card_stored_at     TEXT;
