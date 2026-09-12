/* Availability, which is what inventory actually means here.

   Nobody serial-numbers moving bins. The question that matters is "can I take
   40 bins on the 16th?", and answering it means knowing what every accepted
   rental has already reserved on that day.

   A rental holds its bins from the day they go out until `turnaround_days`
   after they are due back — collected Friday evening, sixty bins do not go out
   again Friday night. Bins already returned early release early, because the
   real return date is better information than the planned one. */

import { addDays } from '../../shared/clock.js';

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
  };
}

/* Days off. Returns the reason if `date` is blacked out, else null. */
export async function blackoutOn(env, date) {
  const row = await env.DB.prepare('SELECT reason FROM blackouts WHERE date = ?1').bind(date).first();
  return row ? (row.reason || 'closed') : null;
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

/* The stoplight.

   A request is a question — "can I have 20 bins on the 16th?" — and the
   answer should be visible in the list, not found out by pressing Approve.
   One availability sweep covers every request on screen; each is then judged
   against its own span in memory.

     green   fits, and leaves a reasonable margin on its tightest day
     yellow  fits, but would leave the fleet nearly empty — say yes carefully
     red     does not fit; says by how many and on which day
     grey    nothing to judge: no dates, no package, or no bins on the list

   A request already turned into a rental is judged with that rental's own
   hold left out, so it does not go red for having been accepted. */
const TIGHT_FRACTION = 0.15;

export async function stoplights(env, requests) {
  const { fleetTotal, turnaroundDays } = await getSettings(env);
  const judged = requests.filter(r => r.kind === 'reserve' && r.bins && r.start_date && r.weeks);
  const grey = { light: 'grey', fits: null };
  if (!judged.length || fleetTotal === 0) {
    return Object.fromEntries(requests.map(r => [r.id, grey]));
  }

  const from = judged.map(r => r.start_date).sort()[0];
  const to = judged.map(r => addDays(addDays(r.start_date, 7 * r.weeks), turnaroundDays)).sort().at(-1);
  const span = Math.max(1, Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000) + 1);
  const { days } = await availability(env, from, span);
  const byDate = new Map(days.map(d => [d.date, d]));

  const out = {};
  for (const r of requests) {
    if (!judged.includes(r)) { out[r.id] = grey; continue; }
    const last = addDays(addDays(r.start_date, 7 * r.weeks), turnaroundDays);
    let worst = null;
    for (let d = r.start_date; d <= last; d = addDays(d, 1)) {
      const day = byDate.get(d);
      if (!day) continue;
      // Its own rental, if it has one, is not competition.
      const own = r.rental_id ? day.rentals.find(x => x.id === r.rental_id)?.bins || 0 : 0;
      const available = day.available + own;
      if (!worst || available < worst.available) worst = { date: d, available };
    }
    const available = worst?.available ?? fleetTotal;
    const left = available - r.bins;
    const fits = left >= 0;
    out[r.id] = {
      light: !fits ? 'red' : left < Math.max(1, Math.ceil(fleetTotal * TIGHT_FRACTION)) ? 'yellow' : 'green',
      fits,
      available,
      fleet: fleetTotal,
      short_by: fits ? 0 : -left,
      tightest_day: worst?.date ?? r.start_date,
    };
  }
  return out;
}
