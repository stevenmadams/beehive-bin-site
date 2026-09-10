-- The audit log has always been written; nothing read it back per item, so it
-- only had a time-ordered index. Showing "who did what to this rental" needs to
-- find one entity's rows without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, at DESC);
