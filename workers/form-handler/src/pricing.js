/* GENERATED from data/pricing.json — do not edit by hand.
   Regenerate with: python3 scripts/build-pricing.py */

/* Package pricing in cents. The invoice is raised from this, so it is the
   number that actually moves money — the website's copy is generated from the
   same source so the two cannot disagree. */

export const PRICES = { 10: 3900, 20: 7900, 40: 12900, 60: 17900 };
export const EXTRA  = { 10: 2500, 20: 4000, 40: 6500, 60: 9000 };
export const REPLACEMENT_PER_BIN = 1500;

/* Null for a package we do not sell, so callers must decide what to do rather
   than silently quoting zero. */
export function quoteCents(bins, weeks) {
  if (PRICES[bins] == null) return null;
  return PRICES[bins] + (weeks - 1) * EXTRA[bins];
}
