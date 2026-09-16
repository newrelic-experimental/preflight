/**
 * Shared number formatting helpers for the dashboard SPA.
 *
 * Extracted to consolidate duplicated copies in
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
  if (!Number.isFinite(ms) || ms < 0) return '—';
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
 * Compact "time ago" label for a past epoch-ms timestamp: "just now", "5m
 * ago", "3h ago", "2d ago". Floors to the current bucket so a value never
 * reads as one tick newer than it is.
 */
export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Pretty-print a number for KPI/alert display.
 *
 * - Non-finite values render as the em-dash placeholder used elsewhere in
 *   the SPA so a NaN doesn't bleed into the UI.
 * - Magnitudes ≥ 100 round to whole units.
 * - 10 ≤ magnitude < 100 render with one decimal, smoothing the jump at the
 *   100 boundary.
 * - Below 10, clean integers render bare; non-integers keep two decimals
 *   for readability.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/**
 * Single source of truth for rendering a USD cost. EVERY dollar figure in the
 * dashboard must go through this so the same value renders byte-identically
 * wherever it appears — a session that reads `$6.05` in the list must read
 * `$6.05` in the detail panel, never `$6.0473`. Mixing `toFixed(2)` and
 * `toFixed(4)` on the same field across views is what made costs look wrong.
 *
 * One precision rule, applied uniformly:
 * - `≥ $1`                  → 2 decimals, with thousands separators (`$6.05`, `$1,234.56`).
 * - `$0.10 ≤ value < $1`    → 2 decimals (`$0.42`).
 * - `$0.001 ≤ value < $0.10` → 3 decimals (`$0.088`) — small costs keep a meaningful digit.
 * - `0 < value < $0.001`    → `<$0.001` — never a fake `$0.000`.
 * - exactly `0`             → `$0.00` (a real, measured zero).
 *
 * Non-finite input renders `$0.00`; use {@link formatUsdOrDash} when a missing
 * value (null/undefined) should read as the em-dash placeholder instead.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  const abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  if (abs < 0.001) return '<$0.001';
  const decimals = abs >= 0.1 ? 2 : 3;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * USD cost that may be absent. `null`/`undefined`/non-finite → the em-dash
 * placeholder (`—`, meaning "no data / not computed") — kept distinct from
 * {@link formatUsd}(0)'s `$0.00` (a measured zero) so the UI never conflates
 * "we don't know" with "it was free".
 */
export function formatUsdOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return formatUsd(value);
}

/**
 * Compact token-count label, consistent across the dashboard: "1.3M", "45.2k",
 * "123". Use for any token figure so large counts don't render as a wall of
 * digits (e.g. 32030011 → "32.0M"). Non-finite → em dash.
 */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
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

/**
 * Sub-second/second duration label for latency figures: `16 ms`, `844 ms`,
 * `1.4 s`, `12.8 s`. Hands off to {@link formatDuration} at the 60s boundary
 * so a slow call reads `1m 5s` instead of an unbroken `65.0 s`.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}

/**
 * Whole-percent label for a share value already on a 0-100 scale: `34%`.
 * A positive value that would round to `0` reads `<1%` instead, so a real
 * but tiny share never looks identical to "no share at all" (`0%`).
 */
export function formatPct(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 0.5) return '<1%';
  return `${Math.round(n)}%`;
}

const AXIS_MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Chart axis tick for a day: accepts `YYYY-MM-DD` or `MM-DD` and renders
 * `Aug 13`. Parses the digits directly rather than `new Date(string)` so the
 * tick can't shift a day depending on the viewer's timezone.
 */
export function formatAxisDate(value: string): string {
  const parts = value.split('-');
  const [monthStr, dayStr] = parts.length >= 3 ? [parts[1], parts[2]] : [parts[0], parts[1]];
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return value;
  return `${AXIS_MONTH_LABELS[month - 1]} ${day}`;
}

/**
 * Chart axis tick for an ISO week (`2026-W34`): renders the Monday of that
 * week as `Aug 17`, per the ISO 8601 rule that week 1 is the week containing
 * January 4th. Computed in UTC so DST transitions can't shift the date.
 */
export function formatAxisWeek(value: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7; // Sunday is 0 in JS; ISO wants it as 7.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Weekday - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return `${AXIS_MONTH_LABELS[target.getUTCMonth()]} ${target.getUTCDate()}`;
}

/**
 * Chart axis tick for a dollar amount: `$85` below $1,000, `$1.2k` at or
 * above it. Deliberately coarser than {@link formatUsd} — an axis tick needs
 * to be short, not exact.
 */
export function formatAxisUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
