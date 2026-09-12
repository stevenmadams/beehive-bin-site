/* Availability, which is what inventory means to a booking.

   Nobody serial-numbers moving bins at booking time. The question is "can I
   take 40 bins on the 16th?", and answering it means knowing what every
   accepted rental has already reserved on that day.

   A rental holds its bins from the day they go out until `turnaround_days`
   after they are due back. Bins already returned early release early. Both
   Workers read this: the panel to judge a request, the website to grey out a
   day before anyone asks. */

import { addDays } from './clock.js';
import { closedHolidayOn, closedHolidays } from './holidays.js';

/* The fleet is however many usable bins are on the list — not a number someone
   typed. A count kept separately from the list will drift from it, and the list
   is the one people actually maintain.

   Only bins count. Packages are sold in bins; a dolly on the same list is
   equipment that goes along, not something a booking can run out of. */
export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(results.map(r => [r.key, r.value]));
  const { usable } = await env.DB.prepare(
    "SELECT COUNT(*) AS usable FROM items WHERE kind = 'bin' AND condition = 'good'").first();
  const { unusable } = await env.DB.prepare(
    "SELECT COUNT(*) AS unusable FROM items WHERE kind = 'bin' AND condition IN ('damaged','lost','retired')").first();
  return {
    fleetTotal: usable,
    outOfService: unusable,
    turnaroundDays: Math.max(0, parseInt(map.turnaround_days ?? '1', 10) || 0),
    // "We'll confirm an exact window with you" — this is the one most nights use.
    defaultWindow: map.default_window ?? '6–8pm',
    // Notice the website needs. The panel can book inside it on purpose.
    leadDays: Math.max(0, parseInt(map.lead_days ?? '1', 10) || 0),
    jobsPerSlot: Math.max(1, parseInt(map.jobs_per_slot ?? '2', 10) || 2),
    // Sunday unless told otherwise. Stored as "0,1" style; blank means none.
    closedWeekdays: map.closed_weekdays == null ? [0]
      : String(map.closed_weekdays).split(',').filter(v => v !== '').map(Number),
    closedHolidays: await closedHolidays(env),
  };
}

/* Days off. Returns the reason if `date` is blacked out, else null. */
export async function blackoutOn(env, date) {
  const row = await env.DB.prepare('SELECT reason FROM blackouts WHERE date = ?1').bind(date).first();
  if (row) return row.reason || 'closed';
  return closedHolidayOn(env, date);
}

/* Which rentals hold bins, and over what span. Cancelled ones hold nothing;
   a returned one held bins only up to when it actually came back. */
async function holdings(env, from, to, turnaround, excludeRentalId) {
  const { results } = await env.DB.prepare(
    `SELECT id, bins, status, start_date, due_date, delivered_at, returned_at
     FROM rentals
     WHERE status != 'cancelled' AND bins IS NOT NULL AND start_date IS NOT NULL
       AND date(start_date) <= date(?1)
       AND date(coalesce(substr(returned_at,1,10), due_date), '+' || ?2 || ' days') >= date(?3)
       AND (?4 IS NULL OR id != ?4)`,
  ).bind(to, String(turnaround), from, excludeRentalId ?? null).all();
  return results;
}

/* A day-by-day picture: what is committed, what is out of service, what is
   left. Returned as a list rather than a total because the interesting answer
   is usually "which day is the tight one". */
export async function availability(env, from, days, opts = {}) {
  const { fleetTotal, outOfService, turnaroundDays } = await getSettings(env);
  const to = addDays(from, Math.max(0, days - 1));
  const held = await holdings(env, from, to, turnaroundDays, opts.excludeRentalId);

  const out = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);

    let committed = 0;
    const on = [];
    for (const r of held) {
      const releases = addDays((r.returned_at || '').slice(0, 10) || r.due_date, turnaroundDays);
      if (r.start_date <= day && day <= releases) {
        committed += r.bins;
        on.push({ id: r.id, bins: r.bins, status: r.status });
      }
    }

    out.push({
      date: day,
      fleet: fleetTotal,
      committed,
      available: fleetTotal - committed,
      rentals: on,
    });
  }
  return { fleetTotal, outOfService, turnaroundDays, days: out };
}

/* Can this rental be taken? Looks across its whole span, because the answer is
   decided by its worst day, not its first. */
export async function canFit(env, { startDate, dueDate, bins, excludeRentalId }) {
  const { turnaroundDays } = await getSettings(env);
  const last = addDays(dueDate, turnaroundDays);
  const span = Math.max(1, Math.round((new Date(last) - new Date(startDate)) / 86400000) + 1);
  const { fleetTotal, days } = await availability(env, startDate, span, { excludeRentalId });

  let worst = null;
  for (const d of days) {
    if (!worst || d.available < worst.available) worst = d;
  }

  return {
    fleetTotal,
    fits: fleetTotal > 0 && worst != null && worst.available >= bins,
    shortBy: worst ? Math.max(0, bins - worst.available) : bins,
    tightestDay: worst?.date ?? startDate,
    availableThen: worst?.available ?? 0,
    // No usable bins on the list at all is a different problem from being
    // fully booked — it means nobody has entered the fleet yet.
    fleetUnknown: fleetTotal === 0,
  };
}

