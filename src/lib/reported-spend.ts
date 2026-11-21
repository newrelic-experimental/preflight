import { localStartOfDay } from './date.js';

export type ReportedSpendPeriod = 'daily' | 'weekly';

export interface ReportedSpend {
  readonly periodKind: ReportedSpendPeriod;
  readonly amountUsd: number;
  readonly asOf: string;
}

export const MAX_REPORTED_SPEND_USD = 1_000_000_000;

export function isPeriodKind(v: unknown): v is ReportedSpendPeriod {
  return v === 'daily' || v === 'weekly';
}

export function isValidReportedAmountUsd(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_REPORTED_SPEND_USD;
}

export function parseStoredReportedSpend(raw: unknown): ReportedSpend[] {
  if (!Array.isArray(raw)) return [];
  const byPeriod = new Map<ReportedSpendPeriod, ReportedSpend>();
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { periodKind, amountUsd, asOf } = item as Record<string, unknown>;
    if (
      !isPeriodKind(periodKind) ||
      !isValidReportedAmountUsd(amountUsd) ||
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

function startOfLocalMondayWeek(nowMs: number): number {
  const day = new Date(localStartOfDay(nowMs));
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

export function isReportedSpendStale(entry: ReportedSpend, nowMs: number = Date.now()): boolean {
  const periodStart =
    entry.periodKind === 'daily' ? localStartOfDay(nowMs) : startOfLocalMondayWeek(nowMs);
  return Date.parse(entry.asOf) < periodStart;
}
