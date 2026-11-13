import type { JSX } from 'react';

import { InfoTooltip } from './InfoTooltip';

const ESTIMATE_REASONS: readonly string[] = [
  'Priced from list prices unless a rate multiplier, data residency premium, or custom pricing file is configured. Flat subscriptions are not reflected.',
  'Counts this machine and the platforms Preflight hooks into, not your whole org.',
  'Copilot in VS Code does not report cache writes separately, so they are priced as ordinary input.',
  "Before a session's first token report, cost is estimated from the size of tool inputs and outputs.",
  "Invoices can post later and use their own day and time zone. Preflight days use this machine's local time zone.",
];

interface EstimateMarkerProps {
  readonly withoutInfoButton?: boolean;
}

function EstimateInfo(): JSX.Element {
  return (
    <InfoTooltip
      label="Why this is an estimate"
      text={ESTIMATE_REASONS.map((reason) => (
        <span key={reason} className="block">
          {reason}
        </span>
      ))}
    />
  );
}

export function EstimateMarker({ withoutInfoButton = false }: EstimateMarkerProps): JSX.Element {
  if (withoutInfoButton) {
    return <span className="ml-1 align-middle text-[10px] font-normal text-ink-muted">est.</span>;
  }
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle text-[10px] font-normal text-ink-muted">
      <span>est.</span>
      <EstimateInfo />
    </span>
  );
}

export function EstimateNote(): JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-subtle">
      <span>Costs are estimates.</span>
      <EstimateInfo />
    </span>
  );
}
