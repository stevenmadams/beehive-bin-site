-- How the customer asked to be contacted. Knowing it turns the panel's
-- call/text buttons from a guess into the right first move.
ALTER TABLE requests ADD COLUMN contact_pref TEXT;  -- text | call | email | NULL (not asked)
