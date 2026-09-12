/* What day it is, for the business.

   Every "is this late", "what is tonight", "has that date passed" in both
   Workers goes through here. Cloudflare's clock is UTC, and UTC rolls over at
   6pm Mountain — which is when the van is out. Left to the platform, the
   evening run showed tomorrow's jobs at 6:01pm, bins being collected that
   evening turned overdue, and the website refused a booking for tomorrow as
   "already passed". A date is only meaningful in the timezone of the people
   living it.

   SQL never uses date('now') for the same reason: the day is worked out here
   and bound in. */

export const TZ = 'America/Denver';

const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: false });

/* YYYY-MM-DD in Mountain Time, now or for a given instant. */
export const businessDate = (at = new Date()) => ymd.format(at);
export const today = () => businessDate();

/* Whole hours into the Mountain day, 0–23. */
export const hourNow = (at = new Date()) => parseInt(hm.format(at).split(':')[0], 10) % 24;

/* Calendar arithmetic on YYYY-MM-DD strings, timezone-free. */
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const addWeeks = (iso, w) => addDays(iso, 7 * w);
export const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000);
export const isSunday = iso => new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;
export const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);

/* The start of a Mountain calendar day as an instant — for "48 hours before
   delivery", which the customer reads as before the day, not before 00:00 UTC. */
export function startOfDay(iso) {
  // Find the UTC instant at which Mountain Time reads iso 00:00, by probing
  // both possible offsets (MST −7, MDT −6) and taking the one that lands.
  for (const off of [6, 7]) {
    const guess = new Date(`${iso}T0${off}:00:00Z`);
    if (businessDate(guess) === iso && hourNow(guess) === 0) return guess;
  }
  return new Date(`${iso}T07:00:00Z`);
}
