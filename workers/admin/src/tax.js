/* Utah sales tax rates for the service area.

   Sourced to where the customer receives the property, not to where we are —
   so the rate follows the delivery address, and the cities we serve do not all
   charge the same. Rates change quarterly, so each city carries a list of
   effective-dated entries rather than a single number.

   Source: Utah State Tax Commission combined sales & use tax rate tables
   (tax.utah.gov/business/sales-tax/sales/rates). Verified 2026-09-10 against
   the Q3 and Q4 2026 tables. CHECK THIS EACH QUARTER — a stale table
   undercollects quietly, which is the expensive direction to be wrong in.

   Entries are newest-last; the applicable rate is the last one whose `from`
   date is on or before the date being taxed. */

export const TAX_TABLE_VERIFIED = '2026-09-10';

const WEBER = [
  { from: '2000-01-01', rate: '7.25' },
  { from: '2026-10-01', rate: '7.45' },   // Q4 2026 increase, already published
];
const DAVIS = [{ from: '2000-01-01', rate: '7.25' }];
const DAVIS_SUNSET = [{ from: '2000-01-01', rate: '7.15' }];

const RATES = {
  // Weber County
  'ogden': WEBER,
  'south ogden': WEBER,
  'roy': WEBER,
  'west haven': WEBER,
  // Davis County
  'clinton': DAVIS,
  'clearfield': DAVIS,
  'syracuse': DAVIS,
  'layton': DAVIS,
  'kaysville': DAVIS,
  'farmington': DAVIS,
  'sunset': DAVIS_SUNSET,
};

export class TaxError extends Error {}

/* Delivery city arrives as free text from the public reserve form, so "Kaysville",
   " kaysville " and "Kaysville, UT" all have to land on the same entry. What is
   deliberately NOT done is falling back to a default rate for an unrecognised
   city — quietly taxing an unknown jurisdiction at a guessed rate is worse than
   refusing to raise the invoice. */
export function normalizeCity(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/,?\s*(ut|utah)\.?$/i, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rateFor(city, onDate) {
  const key = normalizeCity(city);
  if (!key) throw new TaxError('This rental has no delivery city, so the tax rate cannot be determined.');

  const entries = RATES[key];
  if (!entries) {
    throw new TaxError(
      `No tax rate on file for "${city}". Add it to workers/admin/src/tax.js from the Utah Tax Commission tables before invoicing.`,
    );
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(onDate || '')) ? onDate
    : new Date().toISOString().slice(0, 10);

  let applicable = null;
  for (const e of entries) {
    if (e.from <= date) applicable = e;
  }
  if (!applicable) throw new TaxError(`No tax rate in effect for ${city} on ${date}.`);

  return { rate: applicable.rate, city: key, effectiveFrom: applicable.from, date };
}

export const knownCities = () => Object.keys(RATES).sort();
