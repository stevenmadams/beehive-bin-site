-- Distinguish requests the public forms sent from ones staff typed in by hand
-- (a phone-in customer). Without this, a manually created request is
-- indistinguishable from a real submission, which matters when reconciling
-- where business actually came from.
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'web';  -- web | manual
