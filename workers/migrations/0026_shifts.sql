-- When people can drive.
--
-- A row with a weekday is a weekly pattern ("Mondays 5–9pm"); a row with a
-- date is a one-off — either extra hours that day, or `off` = 1 to cancel the
-- pattern for it. Times are 'HH:MM' in Mountain Time, the only clock this
-- business keeps.
--
-- Coverage — who is on a given evening, which hours, how many jobs fit — is
-- derived from these at read time (workers/shared/coverage.js). Nothing is
-- copied onto a calendar, so a changed pattern changes every future day.
CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  weekday     INTEGER,            -- 0 Sunday … 6 Saturday, for a pattern
  date        TEXT,               -- YYYY-MM-DD, for a one-off
  start_time  TEXT,               -- 'HH:MM'
  end_time    TEXT,
  off         INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by  TEXT NOT NULL,
  CHECK ((weekday IS NULL) != (date IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);

-- The hour a visit is booked into, when one was chosen (by the customer, or
-- in the panel). The window text stays for display and ordering; this is
-- what capacity is counted against.
ALTER TABLE rentals ADD COLUMN delivery_slot TEXT;   -- 'HH:MM'
ALTER TABLE rentals ADD COLUMN pickup_slot   TEXT;
