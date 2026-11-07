import type { JSX } from 'react';

import { InfoTooltip } from './InfoTooltip';

// Dollar figures that carry an estimate marker share these reasons, so they stay in one place.
const ESTIMATE_REASONS: readonly string[] = [
  'Priced from list prices unless a rate multiplier, data residency premium, or custom pricing file is configured. Flat subscriptions are not reflected.',
  'Counts this machine and the platforms Preflight hooks into, not your whole org.',
  'Copilot in VS Code does not report cache writes separately, so they are priced as ordinary input.',
  "Before a session's first token report, cost is estimated from text length.",
  "Invoices can post later and use their own day and time zone. Preflight days use this machine's local time zone.",
];

interface EstimateMarkerProps {
  /** Omit the info button where the marker sits inside another button. */
  readonly plain?: boolean;
}

export function EstimateMarker({ plain = false }: EstimateMarkerProps): JSX.Element {
  if (plain) {
    return <span className="ml-1 align-middle text-[10px] font-normal text-ink-muted">est.</span>;
  }
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
