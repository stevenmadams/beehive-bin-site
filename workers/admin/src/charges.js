/* What happens when a rental goes wrong.

   §4 of the rental agreement authorises exactly three things to be charged to
   the card on file beyond the rental fee:

     * a late return, at the extra-week rate per week or partial week;
     * a missing bin, at $15, lid included;
     * damage beyond normal wear, at the same $15 per item.

   Everything here proposes those and nothing more. Proposals are arithmetic —
   the dates and the bin counts already say what the agreement allows — but
   nothing is raised without someone pressing the button, because the gap
   between "three days late" and "her father died on Tuesday" is a judgement
   call, and a card on file makes the wrong one expensive to undo. */

import { EXTRA, REPLACEMENT_PER_BIN } from './pricing.js';

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / DAY);

/* "Each week or partial week the Bins are kept past the agreed return date."
   One day late is one week — that is what the agreement says, and softening it
   here would mean the panel and the contract disagree about what is owed. */
export function lateWeeks(rental, asOf = today()) {
  if (!rental.due_date) return 0;
  const end = (rental.returned_at || '').slice(0, 10) || asOf;
  const days = dayDiff(end, rental.due_date);
  return days <= 0 ? 0 : Math.ceil(days / 7);
}

export const daysOverdue = (rental, asOf = today()) =>
  rental.returned_at || !rental.due_date ? 0 : Math.max(0, dayDiff(asOf, rental.due_date));

/* §7: not returned and unreachable 48 hours past the return date means the
   whole set can be treated as unreturned. It is deliberately a separate
   proposal from a counted shortfall — one is "we counted", the other is "we
   gave up", and they should never both be charged. */
export const NON_RETURN_HOURS = 48;

export async function listCharges(env, rentalId) {
  const { results } = await env.DB.prepare(
    `SELECT id, rental_id, kind, qty, unit_cents, amount_cents, taxable, reason, bin_labels,
            square_invoice_id, square_invoice_url, square_status,
            invoiced_at, paid_at, waived_at, waived_by, waive_reason, created_at, created_by
     FROM charges WHERE rental_id = ?1 ORDER BY created_at, id`,
  ).bind(rentalId).all();
  return results;
}

/* Bins this rental is on the hook for, as recorded on the bin list itself.
   A damage charge that cannot name the bins it is for is a charge that loses a
   dispute, so the labels travel with it. */
async function flaggedBins(env, rentalId) {
  const { results } = await env.DB.prepare(
    `SELECT label, kind, condition FROM items WHERE flagged_rental_id = ?1 ORDER BY kind, label`,
  ).bind(rentalId).all();
  const bins = results.filter(b => b.kind === 'bin');
  return {
    damaged: bins.filter(b => b.condition === 'damaged'),
    lost: bins.filter(b => b.condition === 'lost'),
    // §4 prices bins and nothing else. A dolly that came back bent is real
    // money, but not at a rate the customer agreed to — so it is surfaced, not
    // proposed.
    other: results.filter(b => b.kind !== 'bin' && b.condition !== 'good'),
  };
}

/* What the agreement says could be charged, given what is on record right now.

   A kind that already has a live charge is not proposed again: the answer to
   "should this be charged?" has been given once, and asking twice is how a
   customer gets billed twice for the same cracked lid. */
export async function proposals(env, rental) {
  const existing = await listCharges(env, rental.id);
  /* Waived counts as decided. A proposal that reappears after someone chose to
     let it go is the panel arguing with them once a day. */
  const live = new Set(existing.map(c => c.kind));
  const bins = await flaggedBins(env, rental.id);
  const out = [];

  const weeks = lateWeeks(rental);
  const extra = EXTRA[rental.bins];
  if (weeks > 0 && rental.delivered_at && !live.has('late')) {
    if (extra == null) {
      out.push({ kind: 'late', blocked:
        `This is a ${rental.bins}-bin rental, which is not one of the standard packages, so there is no extra-week rate to apply. Add the late fee by hand.` });
    } else {
      const back = (rental.returned_at || '').slice(0, 10);
      out.push({
        kind: 'late', qty: weeks, unit_cents: extra, amount_cents: weeks * extra, taxable: 1,
        reason: `Late return — ${weeks === 1 ? '1 week' : `${weeks} weeks`} past ${rental.due_date}` +
          (back ? ` (collected ${back})` : ' (still out)'),
        note: `§4: the extra-week rate applies for each week or partial week past the return date. ` +
          (back ? '' : `Currently ${daysOverdue(rental)} days over.`),
      });
    }
  }

  const short = rental.bins_returned == null ? 0 : Math.max(0, rental.bins - rental.bins_returned);
  if (short > 0 && !live.has('missing')) {
    out.push({
      kind: 'missing', qty: short, unit_cents: REPLACEMENT_PER_BIN,
      amount_cents: short * REPLACEMENT_PER_BIN, taxable: 1,
      bin_labels: bins.lost.map(b => b.label).join(', ') || null,
      reason: `${short} bin${short === 1 ? '' : 's'} not returned`,
      note: '§4: missing or unreturned bins at $15 each, lid included.',
    });
  }

  // Counted a shortfall but nothing on the bin list says which ones — the
  // charge stands, but the fleet is now wrong and will over-promise bookings.
  if (short > 0 && bins.lost.length !== short) {
    out.push({ kind: 'note', blocked:
      `${short} bin${short === 1 ? ' is' : 's are'} unaccounted for but ${
        bins.lost.length === 0 ? 'none are' : `only ${bins.lost.length} are`} marked lost on the bin list. ` +
      'Mark them in Inventory or they stay bookable.' });
  }

  if (bins.damaged.length && !live.has('damage')) {
    out.push({
      kind: 'damage', qty: bins.damaged.length, unit_cents: REPLACEMENT_PER_BIN,
      amount_cents: bins.damaged.length * REPLACEMENT_PER_BIN, taxable: 1,
      bin_labels: bins.damaged.map(b => b.label).join(', '),
      // The labels ride in bin_labels, not in the sentence — they are printed
      // beside it, and saying them twice reads like a mistake.
      reason: `Damage beyond normal wear — ${bins.damaged.length} bin${bins.damaged.length === 1 ? '' : 's'}`,
      note: '§4: damage beyond normal wear at $15 per item. Scuffs and light scratches are never charged.',
    });
  }

  /* §7 only once the 48 hours are up, and only while the bins are genuinely
     still out. It replaces the late fee rather than adding to it — charging
     someone for the bins and for keeping them is charging twice. */
  if (!rental.returned_at && rental.delivered_at && daysOverdue(rental) * 24 >= NON_RETURN_HOURS
      && !live.has('missing')) {
    out.push({
      kind: 'missing', section: 7, qty: rental.bins, unit_cents: REPLACEMENT_PER_BIN,
      amount_cents: rental.bins * REPLACEMENT_PER_BIN, taxable: 1,
      reason: `${rental.bins} bins treated as unreturned — ${daysOverdue(rental)} days past ${rental.due_date}`,
      note: `§7: after ${NON_RETURN_HOURS} hours past the return date, with no contact, the full replacement rate applies to everything outstanding. ` +
        'Try to reach them first — this one is close to writing the rental off.',
      confirm: 'Only after you have tried to reach them.',
    });
  }

  if (bins.other.length && !live.has('other')) {
    out.push({ kind: 'note', blocked:
      `Also flagged to this rental: ${bins.other.map(b => `${b.label} (${b.condition})`).join(', ')}. ` +
      'The agreement only sets a rate for bins, so if that is being charged, add it by hand.' });
  }

  return { proposals: out, charges: existing, flagged: bins };
}

export const outstanding = charges =>
  charges.filter(c => !c.waived_at && !c.paid_at && !c.invoiced_at);

export const owedCents = charges =>
  charges.filter(c => !c.waived_at).reduce((n, c) => n + c.amount_cents, 0);
