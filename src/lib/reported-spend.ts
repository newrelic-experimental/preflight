import { localStartOfDay } from './date.js';

export type ReportedSpendPeriod = 'daily' | 'weekly';

export interface ReportedSpend {
  readonly periodKind: ReportedSpendPeriod;
  readonly amountUsd: number;
  readonly asOf: string;
}

export const MAX_REPORTED_SPEND_USD = 1_000_000_000;

function isPeriodKind(v: unknown): v is ReportedSpendPeriod {
  return v === 'daily' || v === 'weekly';
}

/** Keeps the well-formed entries of a hand-edited or older config file. */
export function parseStoredReportedSpend(raw: unknown): ReportedSpend[] {
  if (!Array.isArray(raw)) return [];
  const byPeriod = new Map<ReportedSpendPeriod, ReportedSpend>();
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { periodKind, amountUsd, asOf } = item as Record<string, unknown>;
    if (
      !isPeriodKind(periodKind) ||
      typeof amountUsd !== 'number' ||
      !Number.isFinite(amountUsd) ||
      amountUsd < 0 ||
      amountUsd > MAX_REPORTED_SPEND_USD ||
      typeof asOf !== 'string' ||
      Number.isNaN(Date.parse(asOf))
    ) {
      continue;
    }
    byPeriod.set(periodKind, { periodKind, amountUsd, asOf });
  }
  return [...byPeriod.values()];
}

export function findReportedSpend(
  entries: readonly ReportedSpend[] | undefined,
  periodKind: ReportedSpendPeriod,
): ReportedSpend | null {
  return entries?.find((e) => e.periodKind === periodKind) ?? null;
}

function startOfLocalWeek(nowMs: number): number {
  const day = new Date(localStartOfDay(nowMs));
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/** A value is stale once its period (local day, or local Monday-based week) has ended. */
export function isReportedSpendStale(entry: ReportedSpend, nowMs: number = Date.now()): boolean {
  const periodStart =
    entry.periodKind === 'daily' ? localStartOfDay(nowMs) : startOfLocalWeek(nowMs);
  return Date.parse(entry.asOf) < periodStart;
}

/** "3:42 PM" for a current value, "Nov 6, 3:42 PM" once it is stale. */
export function formatReportedAsOf(entry: ReportedSpend, stale: boolean): string {
  const d = new Date(entry.asOf);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!stale) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
