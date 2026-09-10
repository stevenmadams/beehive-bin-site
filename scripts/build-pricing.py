#!/usr/bin/env python3
"""Generate the code copies of package pricing, and check the prose ones.

Pricing lived in three places that had to agree — the public reserve form, the
admin panel's quote preview, and the Worker that raises the invoice — plus prose
on four pages and in the rental agreement. Quoting one price on the website and
charging another is the kind of mistake that costs a customer's trust once and
an accountant's afternoon afterwards.

The three code copies are generated. Prose is only checked: how a price change
is worded is a human decision, especially in the agreement.
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((ROOT / 'data/pricing.json').read_text())
pkgs = data['packages']

BANNER = ('/* GENERATED from data/pricing.json — do not edit by hand.\n'
          '   Regenerate with: python3 scripts/build-pricing.py */\n')

dollars = lambda key: '{ ' + ', '.join(f"{p['bins']}: {p[key]}" for p in pkgs) + ' }'
cents   = lambda key: '{ ' + ', '.join(f"{p['bins']}: {p[key] * 100}" for p in pkgs) + ' }'

# --- 1. the admin Worker (cents: it computes what is charged) --------------
(ROOT / 'workers/admin/src/pricing.js').write_text(BANNER + f'''
/* Package pricing in cents. The invoice is raised from this, so it is the
   number that actually moves money — the website's copy is generated from the
   same source so the two cannot disagree. */

export const PRICES = {cents('first_week')};
export const EXTRA  = {cents('extra_week')};
export const REPLACEMENT_PER_BIN = {data['other_charges']['replacement_per_bin'] * 100};

/* Null for a package we do not sell, so callers must decide what to do rather
   than silently quoting zero. */
export function quoteCents(bins, weeks) {{
  if (PRICES[bins] == null) return null;
  return PRICES[bins] + (weeks - 1) * EXTRA[bins];
}}
''')

# --- 2 & 3. the two browser copies, between markers ------------------------
def patch(path, block):
    p = ROOT / path
    s = p.read_text()
    new, n = re.subn(r'(// PRICING:start\n).*?(\s*// PRICING:end)',
                     lambda m: m.group(1) + block + m.group(2), s, flags=re.S)
    if not n:
        print(f'  ! {path}: no PRICING markers — add them, then rerun')
        return False
    p.write_text(new)
    print(f'  {path}: regenerated')
    return True

browser = (f"  const PRICES = {dollars('first_week')};   // per week, delivery included\n"
           f"  const EXTRA  = {dollars('extra_week')};   // each additional week")
patch('reserve.html', browser)
panel = (f"const PRICES = {dollars('first_week')};\n"
         f"const EXTRA  = {dollars('extra_week')};")
patch('workers/admin/public/index.html', panel)

# --- 4. check the prose ----------------------------------------------------
known = {p['first_week'] for p in pkgs} | {p['extra_week'] for p in pkgs}
known |= set(data['other_charges'].values())
# Multi-week totals are quoted on the pricing page and are derived, not separate
# prices — a two-week 20-bin rental is $79 + $40 = $119. The form offers up to
# five weeks, so accept every total in that range.
for p in pkgs:
    for weeks in range(2, 6):
        known.add(p['first_week'] + (weeks - 1) * p['extra_week'])

PROSE = ['index.html', 'pricing.html', 'reserve.html', 'terms.html',
         'faq.html', 'requirements.html', 'about.html',
         'docs/rental-agreement-template.md']

print('\nchecking prose for prices that are not in data/pricing.json:')
stale = 0
for f in PROSE:
    p = ROOT / f
    if not p.exists():
        continue
    text = p.read_text()
    # Ignore the generated block in reserve.html; it is checked by being generated.
    text = re.sub(r'// PRICING:start.*?// PRICING:end', '', text, flags=re.S)
    found = {int(m) for m in re.findall(r'\$(\d{1,4})(?!\d*\s*(?:%|px|em))', text)}
    odd = sorted(found - known)
    if odd:
        stale += 1
        print(f'  ! {f}: mentions {", ".join("$" + str(v) for v in odd)}')
for f, label in ((None, None),):
    pass
if not stale:
    print('  every price mentioned in prose is one we actually charge')

print(f'\npackages: ' + ', '.join(f"{p['bins']} bins ${p['first_week']} (+${p['extra_week']}/wk)" for p in pkgs))
