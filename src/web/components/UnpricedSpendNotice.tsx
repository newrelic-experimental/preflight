import type { JSX } from 'react';

const MAX_IDS_SHOWN = 3;

interface CallUsage {
  readonly calls: number;
  readonly tokens: number;
}

export interface UnpricedSpendNoticeProps {
  readonly unpricedByModel: Readonly<Record<string, CallUsage>> | undefined;
  readonly estimatedByModel?:
    Readonly<Record<string, CallUsage & { readonly estimatedFrom: string }>> | undefined;
}

function pluralCalls(n: number): string {
  return `${n} ${n === 1 ? 'call' : 'calls'}`;
}

function topEntries<T extends CallUsage>(
  byModel: Readonly<Record<string, T>> | undefined,
): [string, T][] {
  return Object.entries(byModel ?? {})
    .filter(([, v]) => v.calls > 0)
    .sort((a, b) => b[1].calls - a[1].calls);
}

function listShown(labels: readonly string[]): string {
  const shown = labels.slice(0, MAX_IDS_SHOWN).join(', ');
  const more = labels.length - MAX_IDS_SHOWN;
  return shown + (more > 0 ? ` +${more} more` : '');
}

export function UnpricedSpendNotice({
  unpricedByModel,
  estimatedByModel,
}: UnpricedSpendNoticeProps): JSX.Element | null {
  const unpriced = topEntries(unpricedByModel);
  const estimated = topEntries(estimatedByModel);
  if (unpriced.length === 0 && estimated.length === 0) return null;

  const unpricedCalls = unpriced.reduce((sum, [, v]) => sum + v.calls, 0);
  const estimatedCalls = estimated.reduce((sum, [, v]) => sum + v.calls, 0);

  return (
    <div role="status" className="space-y-1 mb-4">
      {unpriced.length > 0 && (
        <div className="bg-accent-amber/5 border border-accent-amber/40 text-xs rounded-md px-3 py-2">
          <span className="text-accent-amber">
            {pluralCalls(unpricedCalls)} unpriced ({listShown(unpriced.map(([m]) => m))}). Spend is
            understated.
          </span>
        </div>
      )}
      {estimated.length > 0 && (
        <div className="border border-border-subtle text-xs rounded-md px-3 py-2">
          <span className="text-ink-muted">
            {pluralCalls(estimatedCalls)} priced from a sibling model (
            {listShown(estimated.map(([m, v]) => `${m} as ${v.estimatedFrom}`))}). Spend is an
            estimate.
          </span>
        </div>
      )}
    </div>
  );
}
