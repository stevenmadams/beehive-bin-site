# Admin backend — setup and operation

*The panel at `admin.beehivebin.co`. Written 2026-09-10, first build.*

This is Stage 3 from [stage2-square-automation.md](stage2-square-automation.md),
built ahead of Stage 2: requests now land in a database instead of only an
inbox, and staff work them from a panel. Square and e-sign still come later.

## What exists

```
reserve/contact form ──POST──▶ beehive-forms ──┬─▶ D1 `requests` row
   (beehivebin.co)              (api.…)        └─▶ notification email (Resend)

                       staff ──▶ Cloudflare Access ──▶ beehive-admin
                                 (email PIN)           (admin.…) reads/writes D1
```

- **`workers/migrations/0001_init.sql`** — `requests`, `employees`, `audit_log`.
- **`workers/form-handler/`** — unchanged job, plus a D1 insert. Storing and
  emailing are independent: a Resend outage no longer loses a request, and a D1
  hiccup no longer silences the notification. The customer only sees an error if
  *both* fail.
- **`workers/admin/`** — the panel. `src/auth.js` verifies the Access JWT,
  `src/index.js` is the API, `public/index.html` is the whole UI.
  `src/inventory.js` answers what is free on a date, `src/charges.js` works out
  what §4 allows when a rental goes wrong, `src/square.js` talks to Square and
  `src/tax.js` / `src/pricing.js` are generated from `data/`.

**Every tab works.** A request is a question; a rental is a job; a customer
is a person. Requests lists open questions (new and lapsed). Approving makes
a rental and the request leaves the list; declining files the person under
Customers. Rentals lists live jobs — through inspection — and a finished or
cancelled one is history on the customer. A rental is a full page built around
its five stages — Booked, Delivered, Collected, Inspected & cleaned, Settled.
The current stage is open with the work it needs; passed stages are a line
each (the last one undoable); stages ahead are dim. The bins are chosen only
while loading the van; flagging an issue happens only at inspection; charges
are only ever the Settled stage. The panel never uses a browser prompt —
every question is a sheet in the panel's own type (`ask`, `sure`, `tell`).

**Which bins.** `rental_items` ties each bin to the rental it went out on:
auto-picked from the free ones at delivery, or chosen by label, adjustable
until inspection. Inspection is a checklist — tick a bin back, flag an issue
(damaged or lost, with a note) — and writes the bin's own condition, the
rental's count, and what the charges panel proposes. A bin is free again only
once inspected. Inventory shows where every bin is tonight.

**Visits have a business day** (`delivered_on`, `returned_on`), set from the
Mountain clock when the visit is recorded and kept beside the UTC instant.
Lateness reads the day, never the first ten characters of the instant — a
7pm collection on the due date is on time.

**Customers** (`customers`, `workers/shared/customers.js`): one row per
person, matched by email, or by phone when one side has no email (two emails
on one phone are two people who share a line). Both Workers link on write.
Notes attach to the person.

**Schedule** answers "what am I doing tonight": collections first, then
deliveries — bins coming back can go straight out again — with the address, the
gate code, the customer's own notes and a call/text button per job, plus how
many bins go out, come back, and are in use that day. Sundays are shown and
flagged rather than hidden, because a job landing on one is a mistake worth
seeing. **Print run sheet** drops the navigation and prints the list.

**Inventory** is the list of things you own — bins, dollies, hand trucks,
anything with a label on it — one row each, with condition, notes, what it cost
and when it was bought, added in numbered batches. `kind` is a word typed in
the panel, so a new sort of equipment needs no deploy. Bins are the one kind
the rest of the system knows about: the bookable fleet is however many of them
are `good`, so marking one damaged takes it out of availability immediately,
and §4 prices only bins — a bent dolly flagged to a rental is surfaced for a
human rather than charged at a rate the customer never agreed to. A 14-day
strip shows what is free to book, and which day is the tight one.

Approving a reservation creates a **rental** — a separate record, because the
two have different lifecycles: a request is answered once, a rental is worked
for weeks. Customer and terms are copied onto the rental rather than joined, so
a later edit to the request cannot silently rewrite what a driver is delivering
tomorrow. A contact-form enquiry cannot be approved into a rental; it has no
package or dates, and the panel says so.

Rental status is **derived from its milestone timestamps** so status and
history can never disagree: `booked` (approved; not yet signed and paid),
`confirmed`, `out`, `back` (collected, not inspected), `inspected`, and
`cancelled`. What a person sees is the **phase**: the same, except `inspected`
reads as `settling` while a charge is drafted or unpaid, a flagged bin has no
charge decided, or a late return has no late charge — and `done` once nothing
is. `stalled` (booked past its start date) and `overdue` (out past due) are
flags on top. The Rentals tab is a list or a board — one column per live
phase; cards click through and do not drag, since every stage has a rule a
drag would go around. The one
exception is `cancelled`, which is a decision rather than an event and sticks
until someone reinstates it. Milestones toggle both ways: the commonest
correction is marking the wrong rental delivered and needing to undo it.

## Who can do what

Two roles. **Staff** do the evening run: photos, marking delivered and
returned, addresses and windows, counting bins back, flagging damage, notes,
and their own hours. Everything that moves money or makes a promise to a
customer is an **owner's**: approving and declining, sending the link,
cancelling, moving dates, extending, charging and waiving, the staff list,
settings, days off, inventory batches, the activity log. To delegate any of
that, make the person an owner. Enforced in the Worker (`requireOwner`);
the panel hides what it will refuse.

## Who can sign in

Two layers, and they do different jobs:

| Layer | Question it answers | Where it lives |
|---|---|---|
| Cloudflare Access | Is this really that person's email? | Zero Trust dashboard |
| `employees` table | Is that person staff here? | Employees tab |

Anyone with an `@beehivebin.co` mailbox is allowed and auto-enrolled on first
sign-in — **the very first one to sign in becomes `owner`**, so sign in yourself
before anyone else does. Everyone else must be added by an owner in the
Employees tab, which is what lets you give a seasonal driver a Gmail login
without giving them a company mailbox.

Revoking in the Employees tab beats the domain rule: someone who still holds an
`@beehivebin.co` mailbox but is marked revoked stays locked out. Only an owner
can change the staff list, nobody can revoke or demote themselves, and the last
owner cannot be removed.

## One-time setup

*Steps 1 and 2 were completed 2026-09-10. They are kept here as a record of what
was done and how to redo it — for a second environment, or after a disaster.*

**Live values**

| Thing | Value |
|---|---|
| D1 database | `beehive` · `4dfd9b23-a6a4-40ba-87ee-0e9abc57d828` (WNAM) |
| Access team domain | `beehivebin.cloudflareaccess.com` |
| Access application | `admin` · AUD `d3430bffb…fda5816` |
| Access policy | `Staff` — Allow, emails ending in `@beehivebin.co` |

**Do not rename the Zero Trust team.** The team domain is the JWT issuer the
Worker checks. Renaming it invalidates every token and locks everyone out of the
panel until someone edits `ACCESS_TEAM_DOMAIN` and redeploys.

### 1. Create the database

```bash
npx wrangler d1 create beehive
```

Paste the printed `database_id` into **both** `workers/admin/wrangler.toml` and
`workers/form-handler/wrangler.toml` (they share one database), then:

```bash
npx wrangler d1 execute beehive --remote --file=workers/migrations/0001_init.sql
```

### 2. Put Cloudflare Access in front

In the Zero Trust dashboard → **Access → Applications → Add** a self-hosted app:

- Application domain: `admin.beehivebin.co`
- Identity: **One-time PIN** (this is the passwordless email login; no identity
  provider needed)
- Policy: Allow → Include → *Emails ending in* `@beehivebin.co`, and add
  *Emails* entries for any non-domain staff

Then copy two values into `workers/admin/wrangler.toml`:

- `ACCESS_TEAM_DOMAIN` — Settings → Custom Pages shows your team domain
  (`something.cloudflareaccess.com`)
- `ACCESS_AUD` — the application's **Application Audience (AUD) Tag**

Neither is a secret, but `ACCESS_AUD` matters: without the right value, a token
minted for any *other* Access app in your account would be accepted here.

> The Access policy and the Employees tab overlap on purpose. Access decides who
> may reach the Worker at all; the Employees tab decides who the Worker serves.
> Keeping the Access policy broad (`@beehivebin.co` plus a handful of addresses)
> and doing the real gatekeeping in the tab means day-to-day staff changes never
> require the Cloudflare dashboard.

### 3. Deploy

```bash
npx wrangler deploy -c workers/admin/wrangler.toml
npx wrangler deploy -c workers/form-handler/wrangler.toml
```

`admin.beehivebin.co` is attached by the `routes` entry in
`workers/admin/wrangler.toml` — deploying creates the DNS record. That works
because the OAuth login carries `workers_routes:write`, which the older deploy
token used for `api.beehivebin.co` did not.

**Deploy the Access application before the Worker.** If you get the order wrong
the panel is not exposed — it rejects every request that arrives without a valid
Access JWT, so an unprotected deploy fails closed. Don't rely on that as your
security model; it is a backstop, not the plan.

## Time

**The business day is Mountain Time.** `workers/shared/clock.js` is the only
thing that decides what "today" is, and SQL never uses `date('now')`. The
platform clock is UTC, which rolls over at 6pm Mountain — when the van is
out. Before this, the run sheet showed tomorrow at 6:01pm, that evening's
collections went overdue, and the website refused tomorrow as past.

**Windows.** `delivery_window` / `pickup_window` are short phrases per rental
("6–8pm"), stamped from the `default_window` setting when the rental is made.
The run sheet orders jobs by them; the customer sees them once all set and in
the day-before reminder.

**Reminders** go out from the 15:00 UTC cron (9am Mountain) for tomorrow's
deliveries (signed and paid) and pickups (out), once each —
`reminded_delivery_at` / `reminded_pickup_at`. The 09:00 UTC cron is photo
retention.

**Who drives when.** `shifts` holds a weekly pattern per person and one-off
days (extra hours, or off). `workers/shared/coverage.js` turns that into a
day's slots — an hour each, with room for `jobs_per_slot` per driver — and
both Workers read it: the panel's rental drawer and calendar, and the
customer's address step, which offers only the slots with room. Until
anyone has entered a shift, every evening is covered in the usual window.
`delivery_slot` / `pickup_slot` are what capacity is counted against; the
window text beside them is what people read.

**Closed weekdays** (`closed_weekdays` setting, Sunday by default) are the
days nothing starts, online or by phone, named in the refusal. The rental
agreement's prose says Sundays; changing the setting does not rewrite it.

**Holidays** (`workers/shared/holidays.js`) are computed from the statutory
rules — fourth Thursday in November and so on — never fetched or typed.
Federal ones, Utah's Pioneer Day, and the three everyone takes anyway. The
`closed_holidays` setting says which close the business (seven by default);
a closed holiday behaves exactly like a blackout, by name.

**The website's calendar** (`GET /calendar?from&days&bins&weeks` on the
public Worker) answers, per day, whether a booking can start and why not —
closed weekday, holiday, day off, notice — and whether the package asked
about fits, from `workers/shared/availability.js`, the same engine the
panel's stoplight uses. It never says how many bins exist. `reserve.html`
draws it as the date picker; the native date field stays underneath as the
form value and as the fallback if the calendar cannot load.

**Blackouts** (`blackouts` table, Settings tab) stop a booking starting on a
day; adding one reports jobs already booked for it. **Lead time**
(`lead_days`) is what the website needs; the panel can book inside it.

## Demo data

```bash
python3 scripts/seed-demo.py --remote          # plant one of everything
python3 scripts/seed-demo.py --remove --remote # take exactly that out again
```

Twelve people, seven open or answered requests, thirteen rentals — one in
every phase, including tonight's delivery, an overdue one, one back and
uninspected, one settling with a lost and a damaged bin, one with a paid
extension, one cancelled after payment — plus 200 bins and a few dollies,
hours for the owner, a dentist's appointment and three days away. Dates are
relative to the day it runs. Everything it writes is marked (emails end in
`@demo.example.com`, labels start `T-`, `created_by = 'demo-seed'`), so
`--remove` is exact.

## Tests

```bash
npm test
```

Both Workers run inside workerd (Cloudflare's Vitest pool) against a real
in-memory D1 with every migration applied, so a test is the production code
path. `docs/scenarios.md` lists what is covered, as things that happen to the
business, each naming its test file. Square and Resend are stubs under
`workers/*/test/stub-*.js` that record what was asked of them; the other
Worker's RPC entrypoint is stubbed the same way. Nothing in a test can reach
the internet.

## Local development

```bash
npx wrangler d1 execute beehive --local --file=workers/migrations/0001_init.sql
```

Then start the `admin` and `forms` servers from `.claude/launch.json`, or:

```bash
npx wrangler dev -c workers/admin/wrangler.toml --port 8788 --var ACCESS_DEV_EMAIL:you@beehivebin.co
```

There is no Access proxy in front of localhost, so `ACCESS_DEV_EMAIL` stands in
for the JWT. It is double-locked — honoured only when the var is set *and* the
request did **not** arrive through Cloudflare's edge, which is detected by the
absence of a `cf-ray` header. So a copy left in `wrangler.toml` by accident
cannot open a hole on `admin.beehivebin.co`. The `admin-noauth` launch config
runs the same Worker without the var, which is how you re-check that the panel
still fails closed.

> The check deliberately does not look at the hostname. `wrangler dev` reports
> the configured custom domain as the request host, so a loopback test fails
> locally for reasons that have nothing to do with security.

## Square

Wired and verified end to end in **sandbox** on 2026-09-10: invoice created from
the panel, paid with a test card, rental ticked itself to `confirmed` with no
one touching the panel.

| Piece | Where |
|---|---|
| Invoice creation | `workers/admin/src/square.js`, button in the rental drawer |
| Webhook receiver | `workers/form-handler/src/index.js`, `POST /square/webhook` |
| Connection check | `GET /api/square/ping` — read-only, safe any time |

**The webhook is on the public Worker on purpose.** Cloudflare Access guards
`admin.beehivebin.co` and answers unauthenticated callers with a login redirect.
Square has no browser and no session, so a webhook pointed at the panel would be
silently lost. Both Workers share the D1 database, so the panel still sees it.

Square is treated as the authority on payment: the webhook only ever *sets*
`paid_at` from a `PAID` invoice and never clears one recorded by hand. Every
event is written to `square_events` keyed by Square's delivery id before being
acted on, because Square retries any non-2xx and a replayed payment must not
tick anything twice.

### Going to production

Sandbox and production are separate in Square — different tokens, locations,
webhook subscriptions and signature keys. To flip:

1. Add the webhook subscription under the **Production** toggle in the Square
   developer dashboard, same URL and the same two events.
2. In `workers/admin/wrangler.toml`, set `SQUARE_ENV = "production"` and
   `SQUARE_LOCATION_ID = "LEN3W9Q3WM2N8"`.
3. Re-run both secrets with the production values:
   `wrangler secret put SQUARE_ACCESS_TOKEN -c workers/admin/wrangler.toml` and
   `wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY -c workers/form-handler/wrangler.toml`.
4. Deploy both Workers, then check `/api/square/ping` reports
   `"env":"production"` and `"location_found":true` **before** invoicing anyone.

> Sandbox invoices **do** email real addresses. Use your own for tests, never a
> customer's.

## Pricing

`data/pricing.json` is the single source. Run `python3 scripts/build-pricing.py`
after editing and commit what it generates:

| Generated | Used for |
|---|---|
| the `PRICING` block in `reserve.html` | the public form's live quote |
| the `PRICING` block in `workers/admin/public/index.html` | the panel's quote preview on a phone-in |
| `workers/admin/src/pricing.js` | the amount the invoice is actually raised at |

**Prose is checked, not rewritten.** The script scans the website and the rental
agreement for prices that are not in the source and names the files. How a price
change is worded — especially in the agreement — is a human decision, but
forgetting a page is not. It understands multi-week totals as derived (a two-week
20-bin rental is $79 + $40 = $119) rather than flagging them.

Quoting one price on the site and charging another is the kind of mistake that
costs a customer's trust once and an accountant's afternoon afterwards.

## Service area and sales tax

`data/service-area.json` is the single source for where we deliver and what tax
applies. Run `python3 scripts/build-service-area.py` after editing it and commit
the generated files; it writes three things that were previously kept by hand
and drifting apart:

| Generated | Used for |
|---|---|
| the `dcity` options in `reserve.html` | the public booking form's city list |
| `workers/form-handler/src/service-area.js` | validating bookings, the pickup dropdown |
| `workers/admin/src/tax.js` | the per-city rate the invoice is taxed at |

That drift was not hypothetical: the booking form offered Reese, Taylor, Warren,
West Weber and Wolf Creek, none of which had a tax rate, so those bookings could
be taken and then could not be invoiced.

**Rates are per city, not per county.** West Point is 7.15% where the rest of
Davis is 7.25%; Riverdale is 7.45%; Huntsville is 8.25% on a resort tax. Utah
sources a rental to where the customer *receives* the property, so the rate
follows the delivery address rather than ours.

**Re-check the rates each quarter** at tax.utah.gov/sales/ratechanges, and update
`rates_verified` when you do. `/api/square/ping` reports the date it was last
checked. A stale table undercollects silently.

**Open questions for the Tax Commission**, all flagged in the code: whether the
rate should follow the delivery date (what we use) or the payment date; whether
Wolf Creek takes the unincorporated Weber rate given neighbouring Huntsville
carries a resort tax; and how a §4 charge is treated — a late fee is further
consideration for the lease and is taxed, but a $15 replacement for a bin that
never came back may be a retail sale of that bin, or may be untaxed damages.
Charges default to taxable, and `charges.taxable` is per-row so the answer can
be applied without a migration.

## Operating notes

- **Migrations are applied with `d1 execute --file`**, not
  `wrangler d1 migrations apply`. The `d1_migrations` ledger on the remote only
  ever recorded `0001`, so `migrations apply` would try to replay everything
  since and fail on the first duplicate column. Apply a new file to remote and
  local:

  ```bash
  npx wrangler d1 execute beehive -c workers/admin/wrangler.toml --remote --file=workers/migrations/00NN_thing.sql
  npx wrangler d1 execute beehive -c workers/admin/wrangler.toml --local --persist-to workers/admin/.wrangler/state --file=workers/migrations/00NN_thing.sql
  ```


- **`audit_log` is append-only.** Nothing in the app updates or deletes it. It
  is how you answer "who approved this, and when" in three months.
- **`raw_json`** keeps every submitted field verbatim, including any the schema
  does not model. Add a form field without a migration and nothing is lost.
- **`requests.contact_pref`** is `text` / `call` / `email`, or NULL when it was
  never asked (anything submitted before 2026-09-10, and contact-form messages
  where it is inferred from whichever box they filled). The panel's contact
  buttons fall back to showing all three unhighlighted when it is NULL.
- **`requests.source`** is `web` or `manual` — the latter for anything staff
  entered through the panel's **+ New request** button.
- **Approving checks availability.** `canFit()` refuses a request that would
  overbook the fleet on any day of its span, including the turnaround. It is a
  refusal rather than a warning because approving is what emails the customer
  their confirmation link. The panel offers an override, and taking it writes a
  `rental.overbooked` line to the audit log.
- **The fleet is the inventory list.** `items` holds one row per thing owned;
  the bookable fleet is `COUNT(*) WHERE kind = 'bin' AND condition = 'good'`.
  There is no fleet-size setting to keep in step with it.

## When a rental goes wrong

§4 of the rental agreement authorises exactly three charges beyond the rental
fee, and `workers/admin/src/charges.js` proposes those and nothing else:

| What happened | What the agreement allows | How it is worked out |
|---|---|---|
| Bins kept past the return date | the extra-week rate per week **or partial week** | `lateWeeks()` — one day over is one week |
| Bins not returned | $15 per bin, lid included | `bins` minus `bins_returned`, once someone has counted |
| Damage beyond normal wear | $15 per item | bins flagged to the rental and marked `damaged` |
| Nothing at all for 48 hours past the date, and unreachable | §7: full replacement for everything outstanding | offered only once the 48 hours are up, and never alongside a counted shortfall |

**Nothing charges itself.** Every proposal waits for someone to press Add, and
the charge carries their name — the gap between "three days late" and "her
father died on Tuesday" is a judgement call, and the card on file makes the
wrong one expensive to undo. Waiving is recorded with a reason rather than
deleted, and a waived kind is not proposed again.

**Counting is what creates a missing-bin charge.** `rentals.bins_returned` is
null until someone counts; "we never counted" and "all of them came back" are
different answers and only one of them supports a charge.

**Charges go out on one invoice, separate from the rental's own.** The rental
was settled at delivery; this is what came after. With a card on file it is
charged under §4 on publish; without one it is an invoice the customer pays
themselves. The webhook settles every charge row sharing that invoice id.

A shortfall with nothing marked lost on the bin list raises a note in the panel:
the charge stands, but those bins are still counted as bookable until someone
marks them in Inventory.

## What's next

In the order that pays off soonest:

1. **Settings** — a panel for the owner to change things without a deploy.
   Pricing and the service area are no longer duplicated (both are generated
   from `data/`), so this is now a convenience rather than a correctness fix.
2. **E-sign** — per this repo's Stage 2 research, Square Contracts has no public
   API, so this stays manual unless that has changed.
