import type { JSX } from 'react';

import { formatPct } from '../lib/format';

export interface RankedBarRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly share: number;
  readonly tone?: string;
}

export interface RankedBarsProps {
  readonly rows: ReadonlyArray<RankedBarRow>;
  readonly max?: number;
  readonly emptyText?: string;
}

const DEFAULT_TONE = 'bg-accent-cyan';

export function RankedBars({
  rows,
  max = 8,
  emptyText = 'No data yet',
}: RankedBarsProps): JSX.Element {
  if (rows.length === 0) {
    return <div className="text-[11px] text-ink-muted">{emptyText}</div>;
  }

  const shown = rows.slice(0, max);
  const hiddenCount = rows.length - shown.length;
  const maxShare = Math.max(...shown.map((row) => row.share), 0);

  return (
    <div>
      {/* Screen-reader table: the bar/label/value layout below is presentational only. */}
      <table className="sr-only">
        <caption>Ranked breakdown</caption>
        <thead>
          <tr>
            <th>Label</th>
            <th>Value</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td>{row.value}</td>
              <td>{formatPct(row.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-0.5" aria-hidden="true">
        {shown.map((row) => {
          const widthPct = maxShare > 0 ? (row.share / maxShare) * 100 : 0;
          return (
            <div
              key={row.key}
              className="grid grid-cols-[minmax(0,1fr)_5rem_auto_2.5rem] items-center gap-2 text-[11px]"
            >
              <span className="truncate text-ink-subtle">{row.label}</span>
              <span className="h-1 rounded-full bg-surface-5">
                <span
                  className={`block h-1 rounded-full ${row.tone ?? DEFAULT_TONE}`}
                  style={{ width: `${widthPct}%` }}
                />
              </span>
              <span className="text-right text-ink-base tabular-nums">{row.value}</span>
              <span className="text-right text-ink-muted tabular-nums">{formatPct(row.share)}</span>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <div className="mt-1.5 text-[10px] italic text-ink-muted">
          +{hiddenCount} more not shown
        </div>
      )}
    </div>
  );
}
