import type { JSX } from 'react';

import { InfoTooltip } from './InfoTooltip';

// Every estimated dollar figure renders this marker, so the reasons stay in one place.
const ESTIMATE_REASONS: readonly string[] = [
  'Priced at public list prices, not your negotiated rate or a flat subscription.',
  'Counts this machine and the platforms Preflight hooks into, not your whole org.',
  'Copilot in VS Code does not report cache writes separately, so they are priced as ordinary input.',
  "Before a session's first token report, cost is estimated from text length.",
  "Invoices can post later and use their own day and time zone. Preflight days use this machine's local time zone.",
];

export function EstimateMarker(): JSX.Element {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[10px] font-normal text-ink-muted">
      <span>est.</span>
      <InfoTooltip
        text={ESTIMATE_REASONS.map((reason) => (
          <span key={reason} className="block">
            {reason}
          </span>
        ))}
      />
    </span>
  );
}
