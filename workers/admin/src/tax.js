/* GENERATED from data/service-area.json — do not edit by hand.
   Regenerate with: python3 scripts/build-service-area.py */

/* Utah sales tax, by delivery city.

   Utah sources a rental to where the customer RECEIVES the property, so the
   rate follows the delivery address rather than ours. Rates vary within a
   county — West Point is 7.15% where the rest of Davis is 7.25%, Riverdale is
   7.45%, Huntsville 8.25% — so every jurisdiction is listed rather than
   defaulted.

   Source: UT TC combined rates, effective 2026-07-01. Verified 2026-09-10.
   RE-CHECK QUARTERLY at tax.utah.gov/sales/ratechanges — a stale rate
   undercollects silently, which is the expensive direction to be wrong in. */

export const TAX_TABLE_VERIFIED = "2026-09-10";
export const TAX_TABLE_SOURCE = "UT TC combined rates, effective 2026-07-01";

const RATES = {
  "bountiful":                [{ from: "2026-07-01", rate: "7.25" }],
  "centerville":              [{ from: "2026-07-01", rate: "7.25" }],
  "clearfield":               [{ from: "2026-07-01", rate: "7.25" }],
  "clinton":                  [{ from: "2026-07-01", rate: "7.25" }],
  "davis county":             [{ from: "2026-07-01", rate: "7.15" }],   // not offered for booking
  "farmington":               [{ from: "2026-07-01", rate: "7.25" }],
  "fruit heights":            [{ from: "2026-07-01", rate: "7.15" }],
  "kaysville":                [{ from: "2026-07-01", rate: "7.25" }],
  "layton":                   [{ from: "2026-07-01", rate: "7.25" }],
  "north salt lake":          [{ from: "2026-07-01", rate: "7.25" }],
  "south weber":              [{ from: "2026-07-01", rate: "7.25" }],
  "sunset":                   [{ from: "2026-07-01", rate: "7.15" }],
  "syracuse":                 [{ from: "2026-07-01", rate: "7.25" }],
  "west bountiful":           [{ from: "2026-07-01", rate: "7.25" }],
  "west point":               [{ from: "2026-07-01", rate: "7.15" }],
  "woods cross":              [{ from: "2026-07-01", rate: "7.25" }],
  "eden":                     [{ from: "2026-07-01", rate: "7.25" }],
  "farr west":                [{ from: "2026-07-01", rate: "7.25" }],
  "harrisville":              [{ from: "2026-07-01", rate: "7.25" }],
  "hooper":                   [{ from: "2026-07-01", rate: "7.25" }],
  "huntsville":               [{ from: "2026-07-01", rate: "8.25" }],
  "liberty":                  [{ from: "2026-07-01", rate: "7.25" }],
  "marriott slaterville":     [{ from: "2026-07-01", rate: "7.25" }],
  "nordic valley":            [{ from: "2026-07-01", rate: "7.25" }],   // not offered for booking
  "north ogden":              [{ from: "2026-07-01", rate: "7.25" }],
  "ogden":                    [{ from: "2026-07-01", rate: "7.25" }],
  "ogden valley":             [{ from: "2026-07-01", rate: "7.25" }],   // not offered for booking
  "plain city":               [{ from: "2026-07-01", rate: "7.25" }],
  "pleasant view":            [{ from: "2026-07-01", rate: "7.25" }],
  "reese":                    [{ from: "2026-07-01", rate: "7.25" }],
  "riverdale":                [{ from: "2026-07-01", rate: "7.45" }],
  "roy":                      [{ from: "2026-07-01", rate: "7.25" }],
  "south ogden":              [{ from: "2026-07-01", rate: "7.25" }],
  "taylor":                   [{ from: "2026-07-01", rate: "7.25" }],
  "uintah":                   [{ from: "2026-07-01", rate: "7.25" }],
  "warren":                   [{ from: "2026-07-01", rate: "7.25" }],
  "washington terrace":       [{ from: "2026-07-01", rate: "7.25" }],
  "weber county":             [{ from: "2026-07-01", rate: "7.25" }],   // not offered for booking
  "west haven":               [{ from: "2026-07-01", rate: "7.25" }],
  "west weber":               [{ from: "2026-07-01", rate: "7.25" }],
  "wolf creek":               [{ from: "2026-07-01", rate: "7.25" }],
};

export class TaxError extends Error {}

/* Delivery city may still arrive as free text on older records, so "Kaysville",
   " kaysville " and "Kaysville, UT 84037" have to land on one entry.
   Deliberately NOT done: falling back to a default for an unrecognised city.
   Taxing an unknown jurisdiction at a guessed rate is worse than stopping. */
export function normalizeCity(city) {
  return String(city || '')
    .toLowerCase()
    .trim()
    .replace(/,?\s*(ut|utah)\.?\s*\d*$/i, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rateFor(city, onDate) {
  const key = normalizeCity(city);
  if (!key) throw new TaxError('This rental has no delivery city, so the tax rate cannot be worked out.');

  const entries = RATES[key];
  if (!entries) {
    throw new TaxError(
      `No Utah tax rate on file for "${city}". If we now serve it, add it to data/service-area.json and regenerate before invoicing.`,
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

/* The cities a booking may name, in their proper form. A request typed in by
   hand goes through this too — "Clnton" cannot be invoiced, and the moment to
   find that out is when the phone is still in your hand. */
export const SERVICE_CITIES = [
  "Bountiful",
  "Centerville",
  "Clearfield",
  "Clinton",
  "Farmington",
  "Fruit Heights",
  "Kaysville",
  "Layton",
  "North Salt Lake",
  "South Weber",
  "Sunset",
  "Syracuse",
  "West Bountiful",
  "West Point",
  "Woods Cross",
  "Eden",
  "Farr West",
  "Harrisville",
  "Hooper",
  "Huntsville",
  "Liberty",
  "Marriott-Slaterville",
  "North Ogden",
  "Ogden",
  "Plain City",
  "Pleasant View",
  "Reese",
  "Riverdale",
  "Roy",
  "South Ogden",
  "Taylor",
  "Uintah",
  "Warren",
  "Washington Terrace",
  "West Haven",
  "West Weber",
  "Wolf Creek"
];
const display = new Map(SERVICE_CITIES.map(c => [normalizeCity(c), c]));
export const serviceCity = input => display.get(normalizeCity(input)) || null;
