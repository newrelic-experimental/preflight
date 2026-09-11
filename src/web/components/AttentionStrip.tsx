import type { JSX } from 'react';

import { EmptyState } from './EmptyState';
import { Pill } from './ui';

export interface AttentionFlag {
  readonly type: string;
  readonly count: number;
  readonly target?: string;
}

export interface AttentionStripProps {
  readonly flags: ReadonlyArray<AttentionFlag>;
  readonly firingCount: number;
  readonly alertsHref: string;
}

const FLAG_LABELS: Record<string, string> = {
  over_delegation: 'Over-delegation',
  re_reading: 'Repeated reads',
  stuck_loop: 'Stuck loop',
  blind_editing: 'Blind editing',
  thrashing: 'Edit/test thrashing',
  anti_pattern_flags: 'Anti-pattern flags',
};

function humanizeFlagType(type: string): string {
  const known = FLAG_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function AttentionStrip({
  flags,
  firingCount,
  alertsHref,
}: AttentionStripProps): JSX.Element {
  if (flags.length === 0 && firingCount === 0) {
    return <EmptyState variant="inline" title="Nothing needs attention." />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {flags.map((flag) => {
        const label = humanizeFlagType(flag.type);
        const hasTarget = Boolean(flag.target) && flag.target !== 'unknown';
        return (
          <Pill key={`${flag.type}-${flag.target ?? ''}`} tone="warning">
            {hasTarget ? `${label} ×${flag.count} on ${flag.target}` : `${label} ×${flag.count}`}
          </Pill>
        );
      })}
      {firingCount > 0 && (
        <a href={alertsHref} className="text-[11px] text-accent-red hover:underline">
          {firingCount} firing
        </a>
      )}
    </div>
  );
}
