-- Statuses that match the five stages a rental goes through.
--
--   booked      approved; the customer has not finished signing and paying
--   confirmed   signed and paid; waiting for delivery day
--   out         at the customer's
--   back        collected, not yet inspected
--   inspected   looked at (shown as "settling" while anything is owed or
--               undecided, and "done" once nothing is)
--   cancelled
--
-- "pending" said nothing about what was pending; "returned" was true of both
-- a rental with bins in the van and one finished a month ago.
UPDATE rentals SET status = 'booked' WHERE status = 'pending';
UPDATE rentals SET status = 'inspected' WHERE status = 'returned' AND inspected_at IS NOT NULL;
UPDATE rentals SET status = 'back' WHERE status = 'returned';
