-- A customer is a person. Requests and rentals were the only records, and
-- the same person appeared in each as a name and an email typed again. This
-- gives them one row — matched by email, or by phone when there is no email
-- — so "have we dealt with them before" and "call them in March" have
-- somewhere to live, and a declined or lapsed enquiry is a lead rather than
-- a dead row.
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT,                 -- lowercased; unique when present
  phone       TEXT,                 -- digits only; shared lines happen, so not unique
  first_name  TEXT,
  last_name   TEXT,
  city        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT,
  updated_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

ALTER TABLE requests ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE rentals  ADD COLUMN customer_id INTEGER REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_rentals_customer ON rentals(customer_id);

-- Backfill from what exists, by email. Phone-only rows are picked up by the
-- Worker the next time they are touched; the panel also links on read.
INSERT OR IGNORE INTO customers (email, first_name, last_name, city)
  SELECT lower(trim(email)), first_name, last_name, delivery_city
  FROM requests WHERE email IS NOT NULL AND trim(email) != ''
  GROUP BY lower(trim(email));
INSERT OR IGNORE INTO customers (email, first_name, last_name, city)
  SELECT lower(trim(email)), first_name, last_name, delivery_city
  FROM rentals WHERE email IS NOT NULL AND trim(email) != ''
  GROUP BY lower(trim(email));
UPDATE requests SET customer_id = (SELECT id FROM customers c WHERE c.email = lower(trim(requests.email)))
  WHERE email IS NOT NULL AND customer_id IS NULL;
UPDATE rentals  SET customer_id = (SELECT id FROM customers c WHERE c.email = lower(trim(rentals.email)))
  WHERE email IS NOT NULL AND customer_id IS NULL;
