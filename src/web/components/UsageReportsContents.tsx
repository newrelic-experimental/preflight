import type { JSX } from 'react';
import type { UsageReportsView } from '../api/client';

/** What a usage report holds, as the banner and Settings show it. The lines come from the server. */
export function UsageReportsContents({
  view,
  inSettings = false,
}: {
  view: UsageReportsView;
  /** Settings shows the payloads itself, so it doesn't point back to Settings. */
  inSettings?: boolean;
}): JSX.Element {
  return (
    <div className="text-xs text-ink-muted">
      <p>
        Once a day, Preflight {view.state === 'on' ? 'sends' : 'would send'} the Preflight team at
        New Relic:
      </p>
      <ul className="list-disc ml-5 mt-1 space-y-0.5">
        {view.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-1">{view.neverSent}</p>
      <p className="mt-1">
        <a className="underline" href={view.privacyUrl} target="_blank" rel="noreferrer">
          Full list of fields
        </a>
        {' · '}
        Exact payloads: {inSettings ? 'below, or' : 'Settings in this dashboard, or'}{' '}
        <code className="font-mono bg-surface-5 px-1 rounded">{view.showCommand}</code>
      </p>
    </div>
  );
}
