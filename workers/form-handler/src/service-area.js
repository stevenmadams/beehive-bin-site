/* GENERATED from data/service-area.json — do not edit by hand.
   Regenerate with: python3 scripts/build-service-area.py */

/* Cities we deliver to and collect from.

   Used to validate what the reserve form sends and to build the confirmation
   page's pickup dropdown. A city not on this list cannot be booked: a free text
   box lets someone arrange a visit we cannot make, and they only find out when
   nobody turns up. */

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
  "Wolf Creek",
];

const canonical = new Map(SERVICE_CITIES.map(c => [c.toLowerCase(), c]));

/* Returns the properly-cased city name, or null. Accepts what people type —
   trailing state, a ZIP, odd spacing — because the alternative is rejecting a
   real booking over a comma. */
export function canonicalCity(input) {
  const k = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/,?\s*(ut|utah)\.?\s*\d*$/i, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return canonical.get(k) || null;
}
