/* US holidays, worked out rather than typed.

   Federal holidays are fixed by statute — "the fourth Thursday in November"
   does not change — so there is nothing to fetch and nothing to keep up to
   date. Utah's Pioneer Day is here because the business is in Utah, and the
   three days everyone actually takes off (the Friday after Thanksgiving,
   Christmas Eve, New Year's Eve) because a bin company does not run on them
   either.

   Dates are the real day, not the federal "observed" Monday: a business that
   works Saturdays cares whether July 4th falls on one. */

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/* The nth (1-based) given weekday of a month; n = -1 for the last. */
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + 7 * (n - 1));
  }
  const lastDay = new Date(Date.UTC(y, m, 0));
  const back = (lastDay.getUTCDay() - weekday + 7) % 7;
  return iso(y, m, lastDay.getUTCDate() - back);
}
const shift = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

export const HOLIDAYS = [
  { key: 'new_years_day',          name: "New Year's Day",             on: y => iso(y, 1, 1),                 default: true },
  { key: 'mlk_day',                name: 'Martin Luther King Jr. Day', on: y => nthWeekday(y, 1, 1, 3) },
  { key: 'presidents_day',         name: "Presidents' Day",            on: y => nthWeekday(y, 2, 1, 3) },
  { key: 'memorial_day',           name: 'Memorial Day',               on: y => nthWeekday(y, 5, 1, -1),      default: true },
  { key: 'juneteenth',             name: 'Juneteenth',                 on: y => iso(y, 6, 19) },
  { key: 'independence_day',       name: 'Independence Day',           on: y => iso(y, 7, 4),                 default: true },
  { key: 'pioneer_day',            name: 'Pioneer Day (Utah)',         on: y => iso(y, 7, 24),                default: true },
  { key: 'labor_day',              name: 'Labor Day',                  on: y => nthWeekday(y, 9, 1, 1),       default: true },
  { key: 'columbus_day',           name: 'Columbus Day',               on: y => nthWeekday(y, 10, 1, 2) },
  { key: 'veterans_day',           name: 'Veterans Day',               on: y => iso(y, 11, 11) },
  { key: 'thanksgiving',           name: 'Thanksgiving',               on: y => nthWeekday(y, 11, 4, 4),      default: true },
  { key: 'day_after_thanksgiving', name: 'Day after Thanksgiving',     on: y => shift(nthWeekday(y, 11, 4, 4), 1), default: true },
  { key: 'christmas_eve',          name: 'Christmas Eve',              on: y => iso(y, 12, 24) },
  { key: 'christmas',              name: 'Christmas Day',              on: y => iso(y, 12, 25),               default: true },
  { key: 'new_years_eve',          name: "New Year's Eve",             on: y => iso(y, 12, 31) },
];

export const DEFAULT_CLOSED = HOLIDAYS.filter(h => h.default).map(h => h.key);

export const holidaysIn = year => HOLIDAYS.map(h => ({ key: h.key, name: h.name, date: h.on(year) }));

/* Which holidays are closed: the setting, or the defaults when none saved. */
export async function closedHolidays(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'closed_holidays'").first();
  if (!row) return DEFAULT_CLOSED;
  const keys = new Set(String(row.value).split(',').filter(Boolean));
  return HOLIDAYS.filter(h => keys.has(h.key)).map(h => h.key);
}

/* The holiday's name if `date` is one we close on, else null. */
export async function closedHolidayOn(env, date) {
  const closed = new Set(await closedHolidays(env));
  const year = Number(date.slice(0, 4));
  const hit = HOLIDAYS.find(h => closed.has(h.key) && h.on(year) === date);
  return hit ? hit.name : null;
}
