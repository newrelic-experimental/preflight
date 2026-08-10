import type { JSX } from 'react';

import { useAnimatedValue } from '../hooks/useAnimatedValue';

export type KpiTone = 'neutral' | 'good' | 'warn' | 'bad';

const TONE: Record<KpiTone, string> = {
  neutral: 'text-ink-base',
  good: 'text-accent-green',
  warn: 'text-accent-amber',
  bad: 'text-accent-red',
};

export interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: KpiTone;
  readonly hero?: boolean;
  readonly animate?: boolean;
  /**
   * The live numeric value backing the animated count-up. Accepts `null` for
   * "genuinely unknown/not-yet-available" (as opposed to a confirmed `0`) —
   * callers should pass the raw nullable metric through rather than
   * coalescing it to `0` first, or the animate branch below renders a
   * misleading "0" instead of falling through to the `value` string (e.g.
   * `value="—"`).
   */
  readonly numericValue?: number | null;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly decimals?: number;
  /**
   * Formatter for the animated value. When set it must match the formatter used
   * to build `value`, so the count-up and the settled string render identically
   * (e.g. pass `formatUsd` for a cost KPI). `prefix`/`suffix`/`decimals` are then
   * ignored — the formatter owns the whole string.
   */
  readonly format?: (n: number) => string;
}

export function Kpi({
  label,
  value,
  sub,
  tone = 'neutral',
  hero = false,
  animate = false,
  numericValue,
  prefix = '',
  suffix = '',
  decimals = 0,
  format,
}: KpiProps): JSX.Element {
  // `null` means "genuinely unknown", same as `undefined` — neither should
  // coalesce to a rendered `0`. Only a real number reaches the animate branch.
  const hasNumericValue = numericValue !== undefined && numericValue !== null;

  const animated = useAnimatedValue(numericValue ?? 0, {
    decimals,
    enabled: animate && hasNumericValue,
    format,
  });

  const display =
    animate && hasNumericValue ? (format ? animated : `${prefix}${animated}${suffix}`) : value;

  const valueClass = hero
    ? 'text-3xl font-bold mt-1 tabular-nums gradient-text'
    : `text-3xl font-bold mt-1 tabular-nums ${TONE[tone]}`;

  return (
    <div className="px-1">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider font-medium">{label}</div>
      <div className={valueClass}>{display}</div>
      {sub && <div className="text-[10px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}
