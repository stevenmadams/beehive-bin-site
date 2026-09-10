-- The customer confirming the package, dates and price are right, before they
-- are asked for an address or a signature. Worth recording rather than assuming:
-- it is the moment they agreed these are the terms being signed for, and it is
-- what lets the flow resume on the right step.
ALTER TABLE rentals ADD COLUMN details_confirmed_at TEXT;

-- Anyone already past this point plainly confirmed it.
UPDATE rentals SET details_confirmed_at = agreement_signed_at
WHERE details_confirmed_at IS NULL AND agreement_signed_at IS NOT NULL;
