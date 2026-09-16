import type { JSX } from 'react';

export interface UsageInsightItem {
  readonly id: string;
  readonly headline: string;
  readonly advice: string;
}

export interface UsageInsightsListProps {
  readonly insights: ReadonlyArray<UsageInsightItem>;
  readonly emptyText?: string;
}

export function UsageInsightsList({
  insights,
  emptyText = 'Nothing stands out in this window.',
}: UsageInsightsListProps): JSX.Element {
  if (insights.length === 0) {
    return <p className="text-xs text-ink-muted">{emptyText}</p>;
  }

  return (
    <div className="mb-4 space-y-2">
      {insights.map((insight) => (
        <div key={insight.id} className="text-xs">
          <p className="text-ink-base font-medium">{insight.headline}</p>
          <p className="text-ink-muted">{insight.advice}</p>
        </div>
      ))}
    </div>
  );
}
