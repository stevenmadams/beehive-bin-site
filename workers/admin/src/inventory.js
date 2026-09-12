/* Availability, which is what inventory actually means here.

   Nobody serial-numbers moving bins. The question that matters is "can I take
   40 bins on the 16th?", and answering it means knowing what every accepted
   rental has already reserved on that day.

   A rental holds its bins from the day they go out until `turnaround_days`
   after they are due back — collected Friday evening, sixty bins do not go out
   again Friday night. Bins already returned early release early, because the
   real return date is better information than the planned one. */

import { addDays } from '../../shared/clock.js';
import { getSettings, availability, canFit, blackoutOn } from '../../shared/availability.js';
export { getSettings, availability, canFit, blackoutOn };

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
