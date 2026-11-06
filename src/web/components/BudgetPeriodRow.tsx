import type { JSX } from 'react';

import type { BudgetPeriod } from '../api/client';
import { Pill } from './ui';
import { formatUsd } from '../lib/format';

function SpendBar({ pct, exceeded }: { pct: number | null; exceeded: boolean }) {
  const fill = pct ?? 0;
  const color = exceeded ? 'bg-accent-red' : fill >= 80 ? 'bg-accent-amber' : 'bg-accent-green';
  return (
    <div className="w-24 h-1.5 bg-surface-5 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.min(fill, 100)}%` }}
      />
    </div>
  );
}

export function BudgetPeriodRow({ label, p }: { label: string; p: BudgetPeriod }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-ink-muted w-20 shrink-0 capitalize">{label}</span>
      <SpendBar pct={p.pctUsed} exceeded={p.exceeded} />
      <span className="text-xs tabular-nums text-ink-base">
        {formatUsd(p.spentUsd)}
        {p.budgetUsd !== null ? ` / ${formatUsd(p.budgetUsd)}` : ''}
        {p.pctUsed !== null ? ` (${p.pctUsed.toFixed(0)}%)` : ''}
      </span>
      {p.exceeded && (
        <Pill tone="danger" size="sm">
          exceeded
        </Pill>
      )}
    </div>
  );
}
