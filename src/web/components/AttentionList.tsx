import type { JSX } from 'react';

import { EmptyState } from './EmptyState';

export interface AttentionRow {
  readonly type: string;
  readonly count: number;
  /** Distinct files or commands the flag landed on; rendered as basenames. */
  readonly targets: readonly string[];
  /** Sessions the flag came from; drives the "View sessions" deep link. */
  readonly sessionIds: readonly string[];
}

export interface AttentionListProps {
  readonly rows: ReadonlyArray<AttentionRow>;
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

const FLAG_ADVICE: Record<string, string> = {
  re_reading:
    'Read a file once and keep it in context. Use /compact when the window fills instead of re-reading.',
  blind_editing: 'Read the file before editing it, and verify each edit before the next.',
  thrashing:
    'Verify changes with a test between edits instead of alternating edit and test blindly.',
  stuck_loop:
    'The same command keeps failing. Read the error and change the approach before retrying.',
  over_delegation:
    'Spawn subagents only for work that needs its own context, and use a cheaper model for simple ones.',
  anti_pattern_flags:
    'Detail lives in each session record. Open a session to see where the flags landed.',
};

const MAX_TARGETS = 3;

export function humanizeFlagType(type: string): string {
  const known = FLAG_LABELS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function basename(target: string): string {
  return target.split('/').pop() || target;
}

export function AttentionList({ rows, firingCount, alertsHref }: AttentionListProps): JSX.Element {
  if (rows.length === 0 && firingCount === 0) {
    return <EmptyState variant="inline" title="Nothing needs attention." />;
  }

  return (
    <div>
      {firingCount > 0 && (
        <a href={alertsHref} className="text-[11px] text-accent-red hover:underline">
          {firingCount} firing
        </a>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => {
            const shown = row.targets.slice(0, MAX_TARGETS).map(basename);
            const hidden = row.targets.length - shown.length;
            const advice = FLAG_ADVICE[row.type];
            return (
              <li
                key={row.type}
                className="flex items-start justify-between gap-3 py-1.5 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink-base">
                    {humanizeFlagType(row.type)} ×{row.count}
                  </div>
                  {shown.length > 0 && (
                    <div className="text-[11px] font-mono text-ink-muted truncate">
                      {shown.join(' · ')}
                      {hidden > 0 ? ` +${hidden} more` : ''}
                    </div>
                  )}
                  {advice && <div className="text-[11px] text-ink-muted">{advice}</div>}
                </div>
                {row.sessionIds.length > 0 && (
                  <a
                    href={`/sessions?sessionIds=${row.sessionIds.join(',')}`}
                    className="shrink-0 text-[11px] text-accent-cyan hover:underline"
                  >
                    View sessions →
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
