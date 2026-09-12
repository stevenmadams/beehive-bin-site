-- The day a visit happened, in the business's own calendar.
--
-- delivered_at and returned_at are instants (UTC). Asking "was it late" by
-- taking the first ten characters of one turns a 7pm Mountain collection on
-- the due date into the next day — a late week for bins that came back on
-- time. The day is decided when the visit is recorded, from the Mountain
-- clock, and kept beside the instant.
ALTER TABLE rentals ADD COLUMN delivered_on TEXT;
ALTER TABLE rentals ADD COLUMN returned_on  TEXT;
-- Existing rows: the instant less six hours is right for Mountain Daylight
-- Time and off by an hour in winter, which cannot cross a date at 7pm.
UPDATE rentals SET delivered_on = date(delivered_at, '-6 hours') WHERE delivered_at IS NOT NULL AND delivered_at LIKE '____-__-__T%';
UPDATE rentals SET returned_on  = date(returned_at,  '-6 hours') WHERE returned_at  IS NOT NULL AND returned_at  LIKE '____-__-__T%';
