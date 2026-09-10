-- The customer-facing confirmation flow: one link that collects addresses,
-- takes agreement acceptance, and hands off to payment.
ALTER TABLE rentals ADD COLUMN confirm_token     TEXT;  -- unguessable, per rental
ALTER TABLE rentals ADD COLUMN confirm_sent_at   TEXT;

-- The signature record. A typed name alone proves little; what makes an
-- electronic signature defensible is the surrounding evidence — what they saw,
-- when, and from where — so it is captured together and never overwritten.
ALTER TABLE rentals ADD COLUMN agreement_name    TEXT;  -- as typed by the signer
ALTER TABLE rentals ADD COLUMN agreement_ip      TEXT;
ALTER TABLE rentals ADD COLUMN agreement_ua      TEXT;
ALTER TABLE rentals ADD COLUMN agreement_version TEXT;  -- which text they accepted

CREATE UNIQUE INDEX IF NOT EXISTS idx_rentals_token ON rentals(confirm_token);
