import { useState } from 'react';
import { shortToolName } from '../lib/format';

interface GanttTimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
}

interface GanttSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly severity: 'warning' | 'critical';
}

interface GanttTimelineProps {
  readonly entries: GanttTimelineEntry[];
  readonly segments: GanttSegment[];
}

function getBarColor(toolName: string): string {
  if (toolName === 'Read') return 'bg-accent-blue';
  if (toolName === 'Edit' || toolName === 'Write') return 'bg-accent-green';
  if (toolName === 'Bash') return 'bg-accent-purple';
  if (toolName === 'Agent') return 'bg-accent-teal';
  return 'bg-ink-subtle';
}

const SEGMENT_LABELS: Record<string, string> = {
  thrashing: 'Edit/Test Thrashing',
  stuck_loop: 'Stuck Loop',
  blind_editing: 'Blind Editing',
  re_reading: 'Repeated Reads',
};

function fmtTickLabel(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function GanttTimeline({ entries, segments }: GanttTimelineProps): JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (entries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls recorded.</div>;
  }

  // Sort by timestamp so out-of-order entries (clock skew, live injection) don't
  // produce negative offsets or clip bars behind the label column. Carry the
  // original index so segment indices (which refer to the unsorted `entries`)
  // still map to the right rows after sorting.
  const sorted = entries
    .map((entry, originalIdx) => ({ entry, originalIdx }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp);
  const firstTs = sorted[0]!.entry.timestamp;
  // Use the maximum end time across all entries, not just the last entry in array
  // order — an intermediate entry may have a longer duration and overflow the track.
  const maxEnd = sorted.reduce(
    (m, { entry }) => Math.max(m, entry.timestamp + (entry.durationMs ?? 50)),
    0,
  );
  const totalDuration = Math.max(maxEnd - firstTs, 1);

  // Compute tick interval — target ~8 visible labels max
  const MAX_TICKS = 8;
  const candidates = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
  // Find the smallest candidate that gives <= MAX_TICKS ticks.
  // Fall back to ceil(totalDuration / MAX_TICKS) so short sessions still
  // get tick marks rather than rendering a blank axis.
  let tickIntervalMs =
    candidates.find((c) => totalDuration / c <= MAX_TICKS) ?? Math.ceil(totalDuration / MAX_TICKS);

  const ticks: number[] = [];
  for (let t = tickIntervalMs; t < totalDuration; t += tickIntervalMs) {
    ticks.push(t);
  }

  // Build per-row segment lookup. Segment indices reference the original
  // `entries` order; map them through the sort so highlights land on the
  // right row when entries arrive out of timestamp order.
  const segmentAt: (GanttSegment | null)[] = new Array(sorted.length).fill(null);
  const originalToSorted = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    originalToSorted.set(sorted[i]!.originalIdx, i);
  }
  for (const seg of segments) {
    const start = Math.max(0, seg.startIndex);
    const end = Math.min(seg.endIndex, entries.length - 1);
    for (let i = start; i <= end; i++) {
      const sIdx = originalToSorted.get(i);
      if (sIdx === undefined) continue;
      if (
        segmentAt[sIdx] === null ||
        (seg.severity === 'critical' && segmentAt[sIdx]!.severity !== 'critical')
      ) {
        segmentAt[sIdx] = seg;
      }
    }
  }

  const maxStaggerMs = 800;
  const perBarDelay = Math.min(30, maxStaggerMs / Math.max(entries.length, 1));

  return (
    <div className="p-2 overflow-x-hidden">
      {/* Time axis */}
      <div className="flex">
        <div className="w-20 shrink-0" />
        <div className="relative flex-1 h-5 border-b border-bg-line overflow-x-auto">
          {ticks.map((t) => {
            const leftPct = (t / totalDuration) * 100;
            return (
              <span
                key={t}
                className="absolute top-0 text-[9px] text-ink-muted tabular-nums -translate-x-1/2"
                style={{ left: `${leftPct}%` }}
              >
                {fmtTickLabel(t)}
              </span>
            );
          })}
        </div>
      </div>

      {/* Rows */}
      <div className="mt-1">
        {sorted.map(({ entry, originalIdx }, idx) => {
          const offsetMs = entry.timestamp - firstTs;
          const duration = entry.durationMs ?? 50;
          const leftPct = (offsetMs / totalDuration) * 100;
          const widthPct = (duration / totalDuration) * 100;
          const seg = segmentAt[idx];
          const borderClass = seg
            ? seg.severity === 'critical'
              ? 'border-l-2 border-l-accent-red'
              : 'border-l-2 border-l-accent-amber'
            : 'border-l-2 border-l-transparent';

          return (
            <div
              key={`${originalIdx}-${entry.timestamp}`}
              className={`flex items-center h-7 ${borderClass}`}
            >
              <div
                className="w-20 shrink-0 truncate text-[11px] text-ink-subtle pr-2 text-right"
                title={entry.toolName}
              >
                {shortToolName(entry.toolName)}
              </div>
              <div className="relative flex-1 h-full flex items-center">
                <div
                  className={`gantt-bar absolute h-5 rounded-sm opacity-80 ${getBarColor(shortToolName(entry.toolName))} ${!entry.success ? 'ring-1 ring-accent-red/60' : ''}`}
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    minWidth: '4px',
                    animationDelay: `${Math.round(idx * perBarDelay)}ms`,
                  }}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {/* Tooltip positioning:
                    - Bars starting past the midpoint (leftPct >= 50) anchor
                      their tooltip to the right edge of the bar so it grows
                      leftward and stays within the track. Math.max(0, ...) clamps
                      the right value when floating-point arithmetic overshoots on
                      full-width bars. Bars in the first half anchor to the left.
                    - The above-the-bar flip fires only for the last 3 rows of the
                      list (idx > sorted.length - 4) AND only when the list has at
                      least 4 rows (idx >= 3). Lists with 3 or fewer entries never
                      flip — their last row is at most idx=2, which never satisfies
                      idx >= 3, so the tooltip always drops below the bar. */}
                {hoveredIndex === idx && (
                  <div
                    className={`absolute z-50 px-2 py-1.5 rounded-lg bg-bg-elevated border border-bg-line text-[11px] text-ink-base shadow-lg whitespace-nowrap pointer-events-none ${idx >= 3 && idx > sorted.length - 4 ? 'bottom-full mb-1' : 'top-full mt-1'}`}
                    style={
                      leftPct >= 50
                        ? { right: `${Math.max(0, 100 - leftPct - widthPct)}%` }
                        : { left: `${leftPct}%` }
                    }
                  >
                    <div className="font-medium">{entry.toolName}</div>
                    {(entry.filePath ?? entry.command) && (
                      <div className="text-ink-subtle truncate max-w-[200px]">
                        {entry.filePath ?? entry.command}
                      </div>
                    )}
                    <div className="text-ink-muted">
                      {entry.durationMs != null ? `${entry.durationMs}ms` : 'unknown'} &middot;{' '}
                      {entry.success ? 'success' : 'failed'}
                    </div>
                    {seg && (
                      <div
                        className={`mt-0.5 font-medium ${seg.severity === 'critical' ? 'text-accent-red' : 'text-accent-amber'}`}
                      >
                        {SEGMENT_LABELS[seg.type] ?? seg.type}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
