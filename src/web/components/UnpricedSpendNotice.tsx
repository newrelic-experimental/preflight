import type { JSX } from 'react';

const MAX_IDS_SHOWN = 3;

export interface UnpricedSpendNoticeProps {
  readonly unpricedByModel:
    Readonly<Record<string, { readonly calls: number; readonly tokens: number }>> | undefined;
}

export function UnpricedSpendNotice({
  unpricedByModel,
}: UnpricedSpendNoticeProps): JSX.Element | null {
  const entries = Object.entries(unpricedByModel ?? {})
    .filter(([, v]) => v.calls > 0)
    .sort((a, b) => b[1].calls - a[1].calls);
  if (entries.length === 0) return null;

  const totalCalls = entries.reduce((sum, [, v]) => sum + v.calls, 0);
  const shown = entries.slice(0, MAX_IDS_SHOWN).map(([model]) => model);
  const more = entries.length - shown.length;
  const ids = shown.join(', ') + (more > 0 ? ` +${more} more` : '');

  return (
    <div
      role="status"
      className="bg-accent-amber/5 border border-accent-amber/40 text-xs rounded-md px-3 py-2 mb-4"
    >
      <span className="text-accent-amber">
        {totalCalls} {totalCalls === 1 ? 'call' : 'calls'} unpriced ({ids}). Spend is understated.
      </span>
    </div>
  );
}
