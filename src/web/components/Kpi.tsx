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
  readonly numericValue?: number;
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
  const animated = useAnimatedValue(numericValue ?? 0, {
    decimals,
    enabled: animate && numericValue !== undefined,
    format,
  });

  const display =
    animate && numericValue !== undefined
      ? format
        ? animated
        : `${prefix}${animated}${suffix}`
      : value;

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
