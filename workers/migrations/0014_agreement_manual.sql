-- An agreement recorded by staff rather than signed by the customer.
--
-- Ticking "Agreement signed" in the panel wrote a timestamp and nothing else,
-- so the record showed a signature with no signer, no name and no version. That
-- is worse than no record: it looks like evidence.
--
-- Staff still need the option — someone signs a paper copy at the door, or
-- agrees on a call — but it must never be mistaken for the customer's own
-- e-signature, which carries a name, a version, a timestamp and a device.
ALTER TABLE rentals ADD COLUMN agreement_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN agreement_manual_by TEXT;
ALTER TABLE rentals ADD COLUMN agreement_manual_reason TEXT;

-- Anything already ticked without a name was recorded by staff, not signed.
UPDATE rentals SET agreement_manual = 1
WHERE agreement_signed_at IS NOT NULL AND (agreement_name IS NULL OR trim(agreement_name) = '');
