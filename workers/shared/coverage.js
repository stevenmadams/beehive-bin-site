/* Who is on, and what that makes possible.

   Shifts are patterns and exceptions; a day's coverage is the union of every
   person on that day, cut into slots (an hour each, by default), with room
   for so many jobs per person per slot. The customer picks from the slots
   with room; the run sheet shows who is driving.

   Until anyone has entered a shift, every day is open in the usual window:
   the business ran that way before this existed, and switching it on should
   not stop the phone ringing. */

import { addDays } from './clock.js';

export const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayOf = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();

/* The days the business does not go out, as weekday numbers. Sunday unless
   the owner says otherwise — a setting, so it is visible in the panel rather
   than a rule someone has to know is in the code. */
export async function closedWeekdays(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'closed_weekdays'").first();
  if (!row) return [0];
  return String(row.value).split(',').filter(v => v !== '').map(Number).filter(n => n >= 0 && n <= 6);
}

/* The weekday name if `date` falls on a closed day, else null. */
export async function closedDayName(env, date) {
  const closed = await closedWeekdays(env);
  const wd = weekdayOf(date);
  return closed.includes(wd) ? WEEKDAY[wd] : null;
}

export const DEFAULTS = { slotMinutes: 60, jobsPerSlot: 2, fallbackStart: '17:00', fallbackEnd: '20:00' };

export const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const toHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ''));

/* "17:00"–"18:00" → "5–6pm"; "11:00"–"12:00" → "11am–12pm". */
export function label(startMin, endMin) {
  const f = (m, withSuffix) => {
    const h24 = Math.floor(m / 60), mm = m % 60;
    const h = h24 % 12 || 12;
    const suf = h24 < 12 ? 'am' : 'pm';
    return `${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}${withSuffix ? suf : ''}`;
  };
  const sameHalf = (startMin < 720) === (endMin < 720) && endMin !== 720;
  return `${f(startMin, !sameHalf)}–${f(endMin, true)}`;
}

async function settings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('slot_minutes','jobs_per_slot','default_window')").all();
  const map = Object.fromEntries(results.map(r => [r.key, r.value]));
  return {
    slotMinutes: Math.max(15, parseInt(map.slot_minutes ?? DEFAULTS.slotMinutes, 10) || DEFAULTS.slotMinutes),
    jobsPerSlot: Math.max(1, parseInt(map.jobs_per_slot ?? DEFAULTS.jobsPerSlot, 10) || DEFAULTS.jobsPerSlot),
  };
}

/* Per day in [from, from+days): who is on and from when, the slots with
   their capacity and use, and whether the day is open at all. */
export async function coverage(env, from, days) {
  const to = addDays(from, Math.max(0, days - 1));
  const { slotMinutes, jobsPerSlot } = await settings(env);

  const { results: shifts } = await env.DB.prepare(
    `SELECT s.id, s.employee_id, e.name, s.weekday, s.date, s.start_time, s.end_time, s.off, s.note
     FROM shifts s JOIN employees e ON e.id = s.employee_id
     WHERE e.active = 1 AND (s.weekday IS NOT NULL OR s.date BETWEEN ?1 AND ?2)`,
  ).bind(from, to).all();
  const configured = shifts.length > 0 || !!(await env.DB.prepare("SELECT 1 FROM shifts LIMIT 1").first());

  const { results: closed } = await env.DB.prepare('SELECT date, reason FROM blackouts WHERE date BETWEEN ?1 AND ?2').bind(from, to).all();
  const blackout = new Map(closed.map(b => [b.date, b.reason || 'closed']));
  const closedDays = await closedWeekdays(env);

  // Jobs already booked into a slot.
  const { results: booked } = await env.DB.prepare(
    `SELECT start_date AS date, delivery_slot AS slot FROM rentals
       WHERE status != 'cancelled' AND delivery_slot IS NOT NULL AND start_date BETWEEN ?1 AND ?2
     UNION ALL
     SELECT due_date, pickup_slot FROM rentals
       WHERE status != 'cancelled' AND pickup_slot IS NOT NULL AND due_date BETWEEN ?1 AND ?2`,
  ).bind(from, to).all();
  const used = new Map();
  for (const b of booked) used.set(`${b.date}|${b.slot}`, (used.get(`${b.date}|${b.slot}`) || 0) + 1);

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();

    // Who is on: a one-off for the date wins over the pattern for that person.
    const byPerson = new Map();
    for (const s of shifts) {
      if (s.date === date) byPerson.set(s.employee_id, s);
      else if (s.weekday === wd && s.date == null && !byPerson.has(s.employee_id)) byPerson.set(s.employee_id, s);
    }
    const staff = [...byPerson.values()].filter(s => !s.off && s.start_time && s.end_time)
      .map(s => ({ id: s.employee_id, name: s.name, start: s.start_time, end: s.end_time }));
    const note = [...byPerson.values()].filter(s => s.off && s.note).map(s => `${s.name}: ${s.note}`).join('; ') || null;

    const closedDay = closedDays.includes(wd) ? WEEKDAY[wd] : null;
    let slots = [];
    if (!blackout.has(date) && !closedDay) {
      if (!configured) {
        // Legacy: the usual evening, one driver's worth of room.
        for (let m = toMin(DEFAULTS.fallbackStart); m < toMin(DEFAULTS.fallbackEnd); m += slotMinutes) {
          slots.push({ start: toHHMM(m), end: toHHMM(m + slotMinutes), label: label(m, m + slotMinutes), capacity: jobsPerSlot });
        }
      } else if (staff.length) {
        const lo = Math.min(...staff.map(s => toMin(s.start)));
        const hi = Math.max(...staff.map(s => toMin(s.end)));
        for (let m = lo; m < hi; m += slotMinutes) {
          const on = staff.filter(s => toMin(s.start) <= m && toMin(s.end) >= m + slotMinutes).length;
          if (!on) continue;
          slots.push({ start: toHHMM(m), end: toHHMM(m + slotMinutes), label: label(m, m + slotMinutes), capacity: on * jobsPerSlot });
        }
      }
    }
    for (const s of slots) {
      s.used = used.get(`${date}|${s.start}`) || 0;
      s.free = Math.max(0, s.capacity - s.used);
    }
    out.push({
      date, closedDay, configured, staff, note,
      blackout: blackout.get(date) || null,
      open: slots.length > 0,
      slots,
    });
  }
  return out;
}

/* The slot a visit goes in, checked for room. Returns the window text to
   store beside it. Throws {status, message} on a problem. */
export async function claimSlot(env, { date, slot, current, force }) {
  if (!isTime(slot)) throw Object.assign(new Error('Pick a time slot.'), { status: 400 });
  const [day] = await coverage(env, date, 1);
  const s = day.slots.find(x => x.start === slot);
  if (!s) throw Object.assign(new Error(`Nobody is scheduled at ${label(toMin(slot), toMin(slot) + 60)} on ${date}.`), { status: 409 });
  // Re-picking the slot it already holds is not a second booking.
  const free = s.free + (current === slot ? 1 : 0);
  if (free <= 0 && !force) throw Object.assign(new Error(`${s.label} on ${date} is full.`), { status: 409 });
  return s.label;
}
