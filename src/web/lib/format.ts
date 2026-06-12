/**
 * Shared number formatting helpers for the dashboard SPA.
 *
 * Extracted in F-048 (CODE_REVIEW.md) to consolidate duplicated copies in
 * AlertBanner.tsx and Today.tsx — keeping them in sync was a maintenance
 * hazard.
 */

/**
 * Return a Tailwind text-color class for a 0–1 quality rate.
 * null → muted (no data); ≥ goodThreshold → green; ≥ warnThreshold → amber; else → red.
 */
export function rateColor(rate: number | null, goodThreshold = 0.8, warnThreshold = 0.5): string {
  if (rate === null) return 'text-ink-muted';
  if (rate >= goodThreshold) return 'text-accent-green';
  if (rate >= warnThreshold) return 'text-accent-amber';
  return 'text-accent-red';
}

/**
 * Return a Tailwind text-color class for a 0–1 composite score.
 * ≥ 0.8 → cyan; ≥ 0.5 → amber; else → red.
 */
export function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-accent-cyan';
  if (score >= 0.5) return 'text-accent-amber';
  return 'text-accent-red';
}

/**
 * Full date + time label: "Jan 5, 2:30 PM". Accepts epoch ms or ISO string.
 * Use for timestamps that may span multiple days (session lists, audit logs).
 */
export function fmtDateTime(value: string | number): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Hour + minute only: "2:30 PM". Accepts epoch ms.
 * Use for same-day timestamps where the date is already clear from context.
 */
export function fmtTimeOfDay(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Compact elapsed-time label: "1:05" (minutes:seconds, zero-padded seconds).
 * Does not include a leading "+"; callers add that in JSX if desired.
 */
export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * Human-friendly session duration across a wide range (seconds → days).
 * Picks the largest non-trivial unit and shows one finer unit when the
 * rounding loss would be noticeable: "45s", "3m 18s", "1h 30m", "2d 4h".
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    const min = totalMin % 60;
    return min > 0 ? `${totalHours}h ${min}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

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
  if (Math.abs(n) >= 10) return n.toFixed(1); // Smooth 1-decimal tier prevents jump at 100 boundary
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/**
 * Shorten MCP tool names for display. Strips the `mcp__<server>__` prefix
 * and shows only the tool-specific suffix (e.g. `nr_observe_health`).
 * Non-MCP tool names pass through unchanged.
 */
export function shortToolName(name: string): string {
  const parts = name.split('__');
  if (parts.length >= 3 && parts[0] === 'mcp') {
    return parts.slice(2).join('__');
  }
  return name;
}
