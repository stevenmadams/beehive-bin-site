/* Utah sales tax rates for the service area.

   Utah sources a rental to where the customer RECEIVES the property, so the
   rate follows the delivery address rather than ours. Rates vary within a
   county — assuming a county default would be wrong for West Point (7.15%),
   Riverdale (7.45%) and Huntsville (8.25%) — so every jurisdiction is listed.

   SOURCE: Utah State Tax Commission combined sales & use tax rate table,
   "Rates in effect as of July 1, 2026"
   https://files.tax.utah.gov/tax/salestax/rate/26q3combined.pdf
   Read directly from that table on 2026-09-10, not transcribed from summaries.

   Rates change quarterly, so each entry is effective-dated: the applicable rate
   is the last one whose `from` date is on or before the date being taxed. As of
   2026-09-10 the Commission has announced NO changes effective 2026-10-01.

   RE-CHECK EACH QUARTER at tax.utah.gov/sales/ratechanges. A stale table
   undercollects silently, which is the expensive direction to be wrong in. */

export const TAX_TABLE_VERIFIED = '2026-09-10';
export const TAX_TABLE_SOURCE = 'UT TC combined rates, effective 2026-07-01';

const at = rate => [{ from: '2026-07-01', rate }];

const RATES = {
  // ---- Davis County ----
  'bountiful': at('7.25'),
  'centerville': at('7.25'),
  'clearfield': at('7.25'),
  'clinton': at('7.25'),
  'farmington': at('7.25'),
  'fruit heights': at('7.15'),
  'kaysville': at('7.25'),
  'layton': at('7.25'),
  'north salt lake': at('7.25'),
  'south weber': at('7.25'),
  'sunset': at('7.15'),
  'syracuse': at('7.25'),
  'west bountiful': at('7.25'),
  'west point': at('7.15'),
  'woods cross': at('7.25'),
  'davis county': at('7.15'),          // unincorporated

  // ---- Weber County ----
  'farr west': at('7.25'),
  'harrisville': at('7.25'),
  'hooper': at('7.25'),
  'huntsville': at('8.25'),            // resort community tax
  'marriott slaterville': at('7.25'),
  'north ogden': at('7.25'),
  'ogden': at('7.25'),
  'ogden valley': at('7.25'),
  'plain city': at('7.25'),
  'pleasant view': at('7.25'),
  'riverdale': at('7.45'),
  'roy': at('7.25'),
  'south ogden': at('7.25'),
  'uintah': at('7.25'),
  'washington terrace': at('7.25'),
  'west haven': at('7.25'),
  'weber county': at('7.25'),          // unincorporated

  // Places people write that are not their own taxing jurisdiction. Eden,
  // Liberty and Nordic Valley sit in the Ogden Valley / unincorporated Weber
  // area and take its rate.
  'eden': at('7.25'),
  'liberty': at('7.25'),
  'nordic valley': at('7.25'),
};

export class TaxError extends Error {}

/* Delivery city arrives as free text from the public reserve form, so
   "Kaysville", " kaysville " and "Kaysville, UT" have to land on one entry.
   Deliberately NOT done: falling back to a default for an unrecognised city.
   Taxing an unknown jurisdiction at a guessed rate is worse than stopping. */
export function normalizeCity(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/,?\s*(ut|utah)\.?\s*\d*$/i, '')   // trailing state and any ZIP
    .replace(/[^a-z\s]/g, ' ')                   // hyphens, periods, commas
    .replace(/\s+/g, ' ')
    .trim();
}

export function rateFor(city, onDate) {
  const key = normalizeCity(city);
  if (!key) throw new TaxError('This rental has no delivery city, so the tax rate cannot be worked out.');

  const entries = RATES[key];
  if (!entries) {
    throw new TaxError(
      `No Utah tax rate on file for "${city}". If we now serve it, add it to workers/admin/src/tax.js from the Tax Commission table before invoicing.`,
    );
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(onDate || ''))
    ? onDate : new Date().toISOString().slice(0, 10);

  let applicable = null;
  for (const e of entries) if (e.from <= date) applicable = e;
  if (!applicable) throw new TaxError(`No rate on file for ${city} as early as ${date}.`);

  return { rate: applicable.rate, city: key, effectiveFrom: applicable.from, date };
}

export const knownCities = () => Object.keys(RATES).sort();
