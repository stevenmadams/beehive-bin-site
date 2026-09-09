# Stage 2: Automated Customer Pipeline (Square)

*Parked plan — revisit when Stage 1's manual steps start dropping balls.
Written 2026-09-09.*

## Where Stage 1 leaves us

The live pipeline is deliberately manual:

1. **Request** — reserve/contact forms POST to Formspree → email to owner.
2. **Approve/deny** — owner replies personally by text or email.
3. **Agreement + card on file** — owner sends a Square Contract (template in
   `docs/rental-agreement-template.md`); customer signs on their phone.
4. **Payment** — owner sends a Square Invoice; customer pays online and can
   save their card on file with consent.

Per customer this costs the owner two dashboard clicks (send contract, send
invoice) plus one reply. Automation is worth building when volume makes those
steps error-prone — rough trigger: **more than ~5 active rentals a week**, or
the first time a signed agreement or invoice is forgotten.

## Hard constraints learned during planning

- **Square Contracts has no public API.** The e-sign step cannot be automated
  through Square. Options: keep the contract step manual forever (fine), or
  pair Square with an e-sign API (Dropbox Sign, Documenso, DocuSign — roughly
  $20+/mo) and keep Square for money only.
- **GitHub Pages is static.** Any automated flow needs a small backend
  elsewhere (Cloudflare Workers or Netlify Functions are the cheap/free fits).
  The site itself can stay on Pages; only the form's POST target changes.
- **PCI scope.** Never collect card numbers in our own forms. Card-on-file via
  API means embedding Square's **Web Payments SDK** so the card is tokenized on
  Square's servers, then stored with the **Cards API** against a Customer.
  Square-hosted invoice/checkout pages keep us out of PCI scope entirely.

## Target architecture

```
reserve form ──POST──▶ Worker/Function ──▶ store request (Airtable/D1/sheet)
                                        └▶ email owner with Approve / Deny links
Approve link ──▶ Worker:
    • create Square Customer (Customers API)
    • fire e-sign request (Dropbox Sign API, template with card-auth clause)
    • or: TODO reminder to send Square Contract manually
e-sign webhook (signed) ──▶ Worker:
    • create + publish Square Invoice (Invoices API) with card-on-file option
payment webhook (paid) ──▶ Worker:
    • mark request confirmed, email owner the delivery run sheet
```

- **State store:** start with Airtable (owner-friendly UI doubles as the
  "dashboard") or Cloudflare D1 if we want everything in one place.
- **Approve/deny UX:** signed one-click links in the notification email; no
  admin UI needed at first.
- **Availability:** with 3–4 bin sets, a simple per-date inventory check in the
  Worker (sets booked vs. sets owned) can auto-flag conflicts before approval.
- **Extra-week charges / damage fees:** with card on file stored via Cards API,
  charges use the Payments API against the saved card, as authorized by the
  signed agreement. Always email a receipt.

## Square APIs involved

| Step | API | Notes |
|---|---|---|
| Customer record | Customers API | one per renter, dedupe by email/phone |
| Card on file | Web Payments SDK + Cards API | tokenize client-side, store server-side |
| Invoice | Invoices API | create draft → publish; supports saved-card payment |
| Later charges | Payments API | `customer_id` + `card_id`, per signed authorization |
| Payment status | Webhooks | `invoice.payment_made`, `payment.updated` |

## Not chosen (and why)

- **Square Checkout/Payment Links only** — no agreement step, no card on file
  guarantee before delivery.
- **Full custom checkout on the site** — max control, but PCI-adjacent work and
  weeks of effort for a business with a handful of concurrent rentals.
- **Square Appointments** — built for service time slots, fights the
  package/date model.

## Rough build order when the time comes

1. Worker + form POST + Airtable + owner notification email (half a day).
2. Approve/deny links → Square Customer + manual-contract reminder (half a day).
3. Invoices API on approval (half a day).
4. E-sign provider integration replacing the manual contract (1–2 days,
   includes webhook plumbing and template migration).
5. Inventory auto-check + run-sheet emails (nice-to-haves).
