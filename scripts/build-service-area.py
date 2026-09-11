#!/usr/bin/env python3
"""Generate everything that depends on where we deliver, from one source.

The service area was drifting into four separate copies — the reserve form's
city field, the booking flow's validation, the confirmation page's pickup
dropdown, and the admin Worker's tax table. Changing one without the others
means the website advertises a city the booking flow refuses, or an invoice
goes out at a guessed rate.

Run after editing data/service-area.json, and commit the generated files.
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((ROOT / 'data/service-area.json').read_text())
cities = data['cities']
bookable = [c for c in cities if c.get('bookable', True)]

BANNER = ('/* GENERATED from data/service-area.json — do not edit by hand.\n'
          '   Regenerate with: python3 scripts/build-service-area.py */\n\n')

# --- 1. the admin Worker's tax table --------------------------------------
def norm(name):
    return re.sub(r'[^a-z\s]', ' ', name.lower()).replace('  ', ' ').strip()

rows = '\n'.join(
    f"  {json.dumps(norm(c['name'])) + ':':<28}[{{ from: {json.dumps(data['rates_effective'])}, rate: {json.dumps(c['rate'])} }}],"
    f"{'' if c.get('bookable', True) else '   // not offered for booking'}"
    for c in cities)

tax = BANNER + f'''/* Utah sales tax, by delivery city.

   Utah sources a rental to where the customer RECEIVES the property, so the
   rate follows the delivery address rather than ours. Rates vary within a
   county — West Point is 7.15% where the rest of Davis is 7.25%, Riverdale is
   7.45%, Huntsville 8.25% — so every jurisdiction is listed rather than
   defaulted.

   Source: {data['rates_source']}. Verified {data['rates_verified']}.
   RE-CHECK QUARTERLY at tax.utah.gov/sales/ratechanges — a stale rate
   undercollects silently, which is the expensive direction to be wrong in. */

export const TAX_TABLE_VERIFIED = {json.dumps(data['rates_verified'])};
export const TAX_TABLE_SOURCE = {json.dumps(data['rates_source'])};

const RATES = {{
{rows}
}};

export class TaxError extends Error {{}}

/* Delivery city may still arrive as free text on older records, so "Kaysville",
   " kaysville " and "Kaysville, UT 84037" have to land on one entry.
   Deliberately NOT done: falling back to a default for an unrecognised city.
   Taxing an unknown jurisdiction at a guessed rate is worse than stopping. */
export function normalizeCity(city) {{
  return String(city || '')
    .toLowerCase()
    .trim()
    .replace(/,?\\s*(ut|utah)\\.?\\s*\\d*$/i, '')
    .replace(/[^a-z\\s]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}}

export function rateFor(city, onDate) {{
  const key = normalizeCity(city);
  if (!key) throw new TaxError('This rental has no delivery city, so the tax rate cannot be worked out.');

  const entries = RATES[key];
  if (!entries) {{
    throw new TaxError(
      `No Utah tax rate on file for "${{city}}". If we now serve it, add it to data/service-area.json and regenerate before invoicing.`,
    );
  }}

  const date = /^\\d{{4}}-\\d{{2}}-\\d{{2}}$/.test(String(onDate || ''))
    ? onDate : new Date().toISOString().slice(0, 10);

  let applicable = null;
  for (const e of entries) if (e.from <= date) applicable = e;
  if (!applicable) throw new TaxError(`No rate on file for ${{city}} as early as ${{date}}.`);

  return {{ rate: applicable.rate, city: key, effectiveFrom: applicable.from, date }};
}}

export const knownCities = () => Object.keys(RATES).sort();
'''
(ROOT / 'workers/admin/src/tax.js').write_text(tax)
# The confirmation flow runs on the public Worker and needs the same rates to
# show a customer the real total rather than "plus tax". Generated, not copied.
(ROOT / 'workers/form-handler/src/tax.js').write_text(tax)

# --- 2. the public Worker's city list -------------------------------------
names = ',\n'.join(f"  {json.dumps(c['name'])}" for c in bookable)
svc = BANNER + f'''/* Cities we deliver to and collect from.

   Used to validate what the reserve form sends and to build the confirmation
   page's pickup dropdown. A city not on this list cannot be booked: a free text
   box lets someone arrange a visit we cannot make, and they only find out when
   nobody turns up. */

export const SERVICE_CITIES = [
{names},
];

const canonical = new Map(SERVICE_CITIES.map(c => [c.toLowerCase(), c]));

/* Returns the properly-cased city name, or null. Accepts what people type —
   trailing state, a ZIP, odd spacing — because the alternative is rejecting a
   real booking over a comma. */
export function canonicalCity(input) {{
  const k = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/,?\\s*(ut|utah)\\.?\\s*\\d*$/i, '')
    .replace(/[^a-z\\s-]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
  return canonical.get(k) || null;
}}
'''
(ROOT / 'workers/form-handler/src/service-area.js').write_text(svc)

# --- 3. the reserve form's dropdown ---------------------------------------
by_county = {}
for c in bookable:
    by_county.setdefault(c['county'], []).append(c['name'])

opts = []
for county in sorted(by_county):
    opts.append(f'                <optgroup label="{county} County">')
    for name in sorted(by_county[county]):
        opts.append(f'                  <option value="{name}">{name}</option>')
    opts.append('                </optgroup>')
options = '\n'.join(opts)

reserve = ROOT / 'reserve.html'
html = reserve.read_text()
block = f'<!-- CITY-OPTIONS:start -->\n{options}\n                <!-- CITY-OPTIONS:end -->'
new_html, n = re.subn(r'<!-- CITY-OPTIONS:start -->.*?<!-- CITY-OPTIONS:end -->',
                      block.replace('\\', '\\\\'), html, flags=re.S)
if n:
    reserve.write_text(new_html)
    print(f'reserve.html: {len(bookable)} options regenerated')
else:
    print('reserve.html: no CITY-OPTIONS markers yet — add them, then rerun')

print(f'tax.js: {len(cities)} jurisdictions')
print(f'service-area.js: {len(bookable)} bookable cities')
