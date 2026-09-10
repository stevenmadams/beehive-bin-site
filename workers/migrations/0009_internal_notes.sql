-- Internal notes as a log rather than a text box.
--
-- A single editable field answered "what do we think about this rental" but
-- never "who said that, and when" — which is the question that actually gets
-- asked, months later, about a damage charge or a difficult pickup.
--
-- Keyed by entity so requests and rentals share one implementation. Nothing
-- here is ever rendered to a customer: the customer-facing Worker does not read
-- this table at all, which is a stronger guarantee than remembering not to.
CREATE TABLE IF NOT EXISTS internal_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,              -- request | rental
  entity_id   INTEGER NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,              -- employee email
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- Some notes need seeing every time rather than scrolling away.
  pinned      INTEGER NOT NULL DEFAULT 0,
  -- Soft delete: an operational log people can quietly rewrite is not worth
  -- much. The row stays, so "who said that" survives a change of mind.
  deleted_at  TEXT,
  deleted_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_entity
  ON internal_notes(entity, entity_id, pinned DESC, created_at DESC);

-- Carry across whatever was already written. The author is unknown for these —
-- that is exactly the gap this table exists to close, so it is recorded as
-- unknown rather than guessed at.
INSERT INTO internal_notes (entity, entity_id, body, author, created_at)
SELECT 'rental', id, notes, 'unknown (migrated)', created_at
FROM rentals WHERE notes IS NOT NULL AND trim(notes) != '';

INSERT INTO internal_notes (entity, entity_id, body, author, created_at)
SELECT 'request', id, internal_notes, 'unknown (migrated)', created_at
FROM requests WHERE internal_notes IS NOT NULL AND trim(internal_notes) != '';
