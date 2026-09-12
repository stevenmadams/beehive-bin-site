# Scenarios

How the business actually runs, written down as things that happen. Each one
is a test in `workers/*/test/` — the `T` column is the test that proves it.
Status is what the code does today, not what the docs say.

Legend: ✅ built and tested · ⚠️ partly there · ❌ missing

Run them with `npm test` (both Workers), or `npm run test:admin` /
`npm run test:forms`. They run in workerd against a real D1, so they are the
same code paths as production; Square and Resend are stubs that record what
was asked of them.

## A customer

| # | Scenario | Status | T |
|---|---|---|---|
| C1 | Fills in the reserve form → a request appears in the panel and the inbox gets a notification | ✅ | forms/submit |
| C2 | Leaves email or phone off the reserve form → refused, told which field | ✅ | forms/submit |
| C3 | Picks a city we don't serve (tampered form) → refused, not stored | ✅ | forms/submit |
| C4 | Asks for a package or week count we don't sell → refused | ✅ | forms/submit |
| C5 | Asks for a start date in the past, or a Sunday → refused | ✅ | forms/submit |
| C6 | Sends a contact-form message → stored, contact method sorted into phone or email | ✅ | forms/submit |
| C7 | Is a bot filling the honeypot → gets a fake yes, nothing stored | ✅ | forms/submit |
| C8 | Opens the confirmation link → sees their package, dates, price **with tax** | ✅ | forms/confirm |
| C9 | Opens a made-up or dead link → 404, no information leaks | ✅ | forms/confirm |
| C10 | Enters delivery address with unit and zip; pickup same or different | ✅ | forms/confirm |
| C11 | Types a junk name on the agreement → refused; on-behalf allowed with a real surname | ✅ | forms/confirm |
| C12 | Signs → agreement version, IP, UA recorded; signed copy emailed | ✅ | forms/confirm |
| C12b | Square says an invoice is paid → rental, extension or charges settle; bad signatures refused; replays ignored | ✅ | forms/webhook |
| C13 | Stores a card → invoice is raised and charged to it; page shows paid | ✅ | forms/confirm, admin/charges |
| C14 | Revisits the link after paying → sees "all done", cannot pay twice | ✅ | forms/confirm |
| C15 | Opens the link after the rental was cancelled → told so, not asked to pay | ✅ | forms/confirm |
| C16 | Cancels ≥48h before delivery → full refund owed; <48h → 50% | ✅ | admin/changes |
| C17 | Asks for more weeks → extension invoice, return date moves | ✅ | admin/changes |
| C18 | Extension would overbook the bins for someone else → refused | ✅ | admin/changes |
| C19 | Is late / loses bins / damages bins → charged only what §4 allows, itemised | ✅ | admin/charges |
| C20 | Gets a reminder the day before delivery and the day before pickup, with the window and address | ✅ | admin/time, forms/confirm |
| C21 | Books online for today → told the earliest day; books a day off → told why | ✅ | forms/submit |
| C22 | Sees the delivery and pickup window once all set | ✅ | forms/confirm |

## Staff, day to day

| # | Scenario | Status | T |
|---|---|---|---|
| S1 | New requests show a badge count; opening one shows everything sent | ✅ | admin/requests |
| S2 | Takes a booking by phone → **+ New request**, source `manual` | ✅ | admin/requests |
| S3 | Phone booking city must be one we serve (typo'd city can't be invoiced) | ✅ | admin/requests |
| S4 | Approves a reservation → rental created, request `converted`, link exists | ✅ | admin/requests |
| S5 | Approves the same request twice → one rental | ✅ | admin/requests |
| S6 | Approves a contact-form enquiry → refused (no package/dates) | ✅ | admin/requests |
| S7 | Approves when the bins aren't free → refused with the tight day; override audited | ✅ | admin/inventory |
| S8 | Declines with a reason; reopens later | ✅ | admin/requests |
| S9 | A request's start date passes unanswered → shows as lapsed | ✅ | admin/requests |
| S10 | Emails the confirmation link → `confirm_sent_at`, mail goes out | ✅ | admin/rentals |
| S11 | Records a paper/phone agreement → must say how; marked staff-recorded | ✅ | admin/rentals |
| S12 | Tries to undo a real customer e-signature → refused | ✅ | admin/rentals |
| S13 | Tries to un-pay a Square-paid invoice → refused | ✅ | admin/rentals |
| S14 | Uploads a delivery photo → rental marked delivered, by whom, when | ✅ | admin/photos |
| S15 | Delivery before start date → locked; unlock is recorded | ✅ | admin/rentals |
| S16 | Return photo before delivery → refused | ✅ | admin/photos |
| S17 | Photos frozen after the visit is committed → can't delete | ✅ | admin/photos |
| S18 | Marks delivered with no photo → must give a reason, audited | ✅ | admin/rentals |
| S19 | Changes the delivery address after delivery → refused | ✅ | admin/rentals |
| S20 | Cancels a pending/confirmed rental with a reason | ✅ | admin/rentals |
| S21 | Cancels while bins are out, or after they're back → refused | ✅ | admin/rentals |
| S22 | Cancels a paid rental → refund amount per the 48h rule is shown and audited | ✅ | admin/changes |
| S23 | Reschedules a rental (new start date) → availability re-checked, due date moves, customer told | ✅ | admin/changes |
| S24 | Adds an internal note → attributed; can edit/delete own | ✅ | admin/notes |
| S25 | Sees who did what in History | ✅ | admin/notes |
| S26 | Rental never confirmed and start date passed → **stalled** badge | ✅ | admin/rentals |
| S27 | Bins out past due date → **overdue** badge, late fee proposed | ✅ | admin/charges |
| S28 | Counts bins back, marks damaged ones → charges proposed, invoiced together | ✅ | admin/charges |
| S29 | Waives a charge → reason recorded; not proposed again | ✅ | admin/charges |
| S30 | Photo retention: deleted after 90 days unless a dispute hold is on | ✅ | admin/photos |
| S31 | Sees a stoplight on each request: green fits, yellow tight, red short (by how many, which day) | ✅ | admin/stoplight |
| S32 | Sets a delivery or pickup window per rental; the usual one is a setting | ✅ | admin/time |
| S33 | Blocks a day off; bookings onto it refused; jobs already on it reported | ✅ | admin/time |
| S34 | Sets the notice the website needs; phone bookings can go inside it | ✅ | admin/time |
| S35 | Days we don't go out are a setting (Sunday by default), refused online and by phone by name; all seven refused | ✅ | admin/time |

## Staff, the evening run

| # | Scenario | Status | T |
|---|---|---|---|
| R1 | Tonight lists today's collections, then today's deliveries | ✅ | admin/schedule |
| R2 | A collection only appears once the bins were actually delivered | ✅ | admin/schedule |
| R3 | Cancelled rentals never appear | ✅ | admin/schedule |
| R4 | Each job carries address, unit, zip, gate code, phone, bin count | ✅ | admin/schedule |
| R5 | A delivery that isn't signed or paid says so | ✅ | admin/schedule |
| R6 | Sunday jobs are flagged | ✅ | admin/schedule |
| R7 | Bins out / back / in use per day; over-committed days shout | ✅ | admin/schedule |
| R8 | Jobs carry their window and are ordered by it; a day off says so | ✅ | admin/time |
| R9 | At 7:30pm, "tonight" is still tonight — nothing is late, locked, lapsed or refused because UTC rolled over | ✅ | admin/clock, forms/submit |

## Inventory

| # | Scenario | Status | T |
|---|---|---|---|
| I1 | Adds 40 bins → B-001…B-040; adds 10 more → B-041…B-050 | ✅ | admin/inventory |
| I2 | Adds dollies, hand trucks, anything → own kind, own prefix | ✅ | admin/inventory |
| I3 | "Hand Truck", "hand-truck", "hand_truck" are one kind | ✅ | admin/inventory |
| I4 | Marks a bin damaged → fleet drops by one, that day and every day | ✅ | admin/inventory |
| I5 | Availability holds bins from delivery through due date **plus turnaround** | ✅ | admin/inventory |
| I6 | Early return releases bins early | ✅ | admin/inventory |
| I7 | Cancelled rental holds nothing | ✅ | admin/inventory |
| I8 | A damaged dolly flagged to a rental → note, not a §4 charge | ✅ | admin/charges |
| I9 | Only an owner can delete an item or add a batch | ✅ | admin/inventory |
| I10 | Turnaround days is a setting; 0 means same-night reuse | ✅ | admin/inventory |

## Who drives when

| # | Scenario | Status | T |
|---|---|---|---|
| A1 | Each person has a weekly pattern ("Mon–Sat 5–9pm") and days that differ (off, or extra hours) | ✅ | admin/availability |
| A2 | Staff set their own hours; only an owner sets someone else's | ✅ | admin/availability |
| A3 | A shift must make sense: real times, end after start, a weekday or a date | ✅ | admin/availability |
| A4 | Until anyone's hours are entered, every evening counts as covered — nothing breaks on day one | ✅ | admin/availability |
| A5 | Once hours exist, a day nobody is on has no slots, and the website is told | ✅ | admin/availability |
| A6 | Two drivers double the room in an hour; booked jobs use it up; a full slot is refused unless forced | ✅ | admin/availability |
| A7 | A day off beats everyone's hours; the run sheet says who is on | ✅ | admin/availability |
| A8 | Customer picks a drop-off and a pickup hour from the slots with room; a full one is not offered and cannot be posted | ✅ | forms/confirm |
| A9 | A day nobody is on tells the customer so, with a way out | ✅ | forms/confirm |
| A10 | The month calendar shows who is on, what is booked, bins free, days closed | ✅ (UI) | — |

## Who can do what

| # | Scenario | Status | T |
|---|---|---|---|
| P1 | First @beehivebin.co sign-in becomes owner; the next becomes staff | ✅ | admin/auth |
| P2 | Outside-domain address must be on the staff list | ✅ | admin/auth |
| P3 | Deactivated employee is refused even with a domain mailbox | ✅ | admin/auth |
| P4 | Staff can't add employees, delete items, change settings | ✅ | admin/auth |
| P5 | The last active owner can't be demoted or deactivated | ✅ | admin/auth |
| P6 | Request through Cloudflare's edge ignores the dev-bypass var | ✅ | admin/auth |
| P7 | Staff do the evening run: photos, milestones, addresses, windows, counting, damage, notes, own hours | ✅ | admin/roles |
| P8 | Staff take a phone booking but cannot approve it | ✅ | admin/roles |
| P9 | Staff cannot send the link, cancel, move, extend, or add/waive/charge fees | ✅ | admin/roles |
| P10 | Staff see no staff list or activity log, and only their own hours ("My hours") | ✅ | admin/roles |

## Not built, on purpose for now

- **Customers tab.** One record per renter across requests. Nothing depends on
  it yet.
