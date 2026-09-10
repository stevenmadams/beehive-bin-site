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

**Requests is the only tab that works.** Rentals, Schedule, Inventory,
Customers and Settings render a description of what will live there. That is
deliberate — see "What's next".

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

Attach `admin.beehivebin.co` to `beehive-admin` the same way
`api.beehivebin.co` is attached to `beehive-forms`.

**Deploy the Access application before the Worker.** If you get the order wrong
the panel is not exposed — it rejects every request that arrives without a valid
Access JWT, so an unprotected deploy fails closed. Don't rely on that as your
security model; it is a backstop, not the plan.

## Local development

```bash
npx wrangler d1 execute beehive --local --file=workers/migrations/0001_init.sql
```

Then start the `admin` and `forms` servers from `.claude/launch.json`, or:

```bash
npx wrangler dev -c workers/admin/wrangler.toml --port 8788 --var ACCESS_DEV_EMAIL:you@beehivebin.co
```

There is no Access proxy in front of localhost, so `ACCESS_DEV_EMAIL` stands in
for the JWT. It is double-locked — it is honoured only when the var is set *and*
the request arrives on a loopback hostname — so a copy left in `wrangler.toml`
by accident cannot open a hole on `admin.beehivebin.co`. The `admin-noauth`
launch config runs the same Worker without it, which is how you re-check that
the panel still fails closed.

## Operating notes

- **`audit_log` is append-only.** Nothing in the app updates or deletes it. It
  is how you answer "who approved this, and when" in three months.
- **`raw_json`** keeps every submitted field verbatim, including any the schema
  does not model. Add a form field without a migration and nothing is lost.
- **Approving does not yet charge or send anything.** It sets a status. The
  contract and invoice are still the manual Square steps from Stage 2.

## What's next

In the order that pays off soonest:

1. **Rentals** — approving a request should create a rental. Until that exists,
   the Schedule and Inventory tabs have nothing real to show.
2. **Availability** — with 3–4 bin sets, check sets-booked against sets-owned
   for the requested dates and flag conflicts before anyone approves.
3. **Square** — Customers API on approval, then Invoices. Stage 2's plan holds.
4. **E-sign** — the one step Square genuinely cannot automate.
