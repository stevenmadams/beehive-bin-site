-- A rental whose photos must survive the retention sweep: a damage charge being
-- argued, a claim, anything where deleting the evidence on schedule would be
-- the wrong outcome. Without this, the policy is either "delete on time and
-- sometimes lose the case" or "never delete and break the promise".
ALTER TABLE rentals ADD COLUMN photo_hold INTEGER NOT NULL DEFAULT 0;
