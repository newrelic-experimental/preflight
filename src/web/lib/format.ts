/**
 * Shared number formatting helpers for the dashboard SPA.
 *
 * Extracted in F-048 (CODE_REVIEW.md) to consolidate duplicated copies in
 * AlertBanner.tsx and Today.tsx — keeping them in sync was a maintenance
 * hazard.
 */

/**
 * Pretty-print a number for KPI/alert display.
 *
 * - Non-finite values render as the em-dash placeholder used elsewhere in
 *   the SPA so a NaN doesn't bleed into the UI.
 * - Magnitudes ≥ 100 round to whole units; below 100 we keep two decimals
 *   for readability except for clean integers which render bare.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
