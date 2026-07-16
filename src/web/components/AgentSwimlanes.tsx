import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatNumber, formatDuration, formatUsdOrDash, shortToolName } from '../lib/format';

// The canonical AgentSpan type now lives in api/client.ts (it mirrors a wire
// response, not a component-local shape) — re-exported here so none of this
// component's existing import sites need to change.
import type { AgentSpan } from '../api/client.js';
export type { AgentSpan } from '../api/client.js';

// A single parent (top-level) tool call, drawn on the shared "Parent activity"
// lane. Shape is the frozen contract a sibling chart passes in — keep stable.
interface ParentEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
}

export interface AgentSwimlanesProps {
  readonly agents: AgentSpan[];
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly parentEntries?: ReadonlyArray<ParentEntry>;
  readonly onSelectRun?: (runId: string) => void;
}

// Cycle the dedicated categorical "series" ramp, one hue per workflow group.
// These are purpose-built grouping tokens: lower-saturation and visually
// distinct from the saturated status/tool accents, so a group bar reads as a
// CATEGORY rather than a status. They carry no semantic meaning (unlike green
// =success, amber=warning, teal="Agent", red=danger). Index is the group's
// position once sorted by earliest startMs, so colors are stable for a given
// session render.
const GROUP_BAR_COLORS = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
] as const;

// Tool → accent color for the parent activity lane. Replicated from
// GanttTimeline.getBarColor (intentionally NOT imported — we don't depend on
// that component). These accents legitimately encode TOOL TYPE here, the same
// way the gantt does, so the parent lane reads consistently with it.
function getParentBarColor(toolName: string): string {
  if (toolName === 'Read') return 'bg-accent-blue';
  if (toolName === 'Edit' || toolName === 'Write') return 'bg-accent-green';
  if (toolName === 'Bash') return 'bg-accent-purple';
  if (toolName === 'Agent') return 'bg-accent-teal';
  return 'bg-ink-subtle';
}

// mm:ss relative to the window start — same axis style as GanttTimeline.
function fmtTickLabel(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

interface AgentGroup {
  readonly runId: string | null;
  readonly name: string;
  readonly earliestStartMs: number;
  readonly agents: AgentSpan[];
}

// Group agents by workflowRunId. Null runId agents collapse into a single
// "Ad-hoc subagents" group. Groups are sorted by their earliest agent start.
function groupAgents(agents: AgentSpan[]): AgentGroup[] {
  const byRun = new Map<string | null, AgentSpan[]>();
  for (const agent of agents) {
    const key = agent.workflowRunId;
    const bucket = byRun.get(key);
    if (bucket) {
      bucket.push(agent);
    } else {
      byRun.set(key, [agent]);
    }
  }

  const groups: AgentGroup[] = [];
  for (const [runId, members] of byRun) {
    const sortedMembers = [...members].sort((a, b) => a.startMs - b.startMs);
    const earliestStartMs = sortedMembers.reduce(
      (m, a) => Math.min(m, a.startMs),
      Number.POSITIVE_INFINITY,
    );
    const name = runId === null ? 'Ad-hoc subagents' : (members[0]?.workflowName ?? 'Workflow run');
    groups.push({ runId, name, earliestStartMs, agents: sortedMembers });
  }

  groups.sort((a, b) => a.earliestStartMs - b.earliestStartMs);
  return groups;
}

// Stable group id used to key collapse state. The parent lane gets a reserved
// id; subagent groups key off their runId (with a fixed token for the ad-hoc
// null-runId group). Stable across re-renders so a user's expand/collapse
// choice sticks even as data refreshes.
const PARENT_GROUP_ID = '__parent__';
const ADHOC_GROUP_ID = '__adhoc__';

function subagentGroupId(runId: string | null): string {
  return runId === null ? ADHOC_GROUP_ID : `run:${runId}`;
}

// Groups with more than this many lanes start collapsed so the chart doesn't
// open at an unreasonable height. Users can still expand them.
const AUTO_COLLAPSE_LANE_THRESHOLD = 15;

export function AgentSwimlanes({
  agents,
  window,
  parentEntries,
  onSelectRun,
}: AgentSwimlanesProps): JSX.Element {
  // hoveredKey identifies the single hovered bar across the whole chart. For
  // subagent bars it's `${groupIndex}:${agentId}`; for parent bars it's
  // `parent:${index}` — distinct namespaces so nothing collides.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const span = Math.max(window.endMs - window.startMs, 1);

  const ticks = useMemo<number[]>(() => {
    const MAX_TICKS = 8;
    const candidates = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
    const tickIntervalMs =
      candidates.find((c) => span / c <= MAX_TICKS) ?? Math.ceil(span / MAX_TICKS);
    const out: number[] = [];
    for (let t = tickIntervalMs; t < span; t += tickIntervalMs) {
      out.push(t);
    }
    return out;
  }, [span]);

  const groups = useMemo(() => groupAgents(agents), [agents]);

  // Parent entries sorted by timestamp so out-of-order entries (clock skew,
  // live injection) never produce a negative offset. Only computed when the
  // caller supplies a parent lane.
  const sortedParentEntries = useMemo<ParentEntry[]>(
    () => (parentEntries ? [...parentEntries].sort((a, b) => a.timestamp - b.timestamp) : []),
    [parentEntries],
  );
  const hasParentLane = parentEntries !== undefined;

  // Total lane count across all groups, used to decide which lanes sit in the
  // bottom portion of the chart so their tooltip flips upward (see below). The
  // parent lane counts as one lane and renders first, so subagent lane indices
  // are offset by it when present.
  const subagentLaneCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.agents.length, 0),
    [groups],
  );
  const parentLaneCount = hasParentLane ? 1 : 0;
  const totalLanes = subagentLaneCount + parentLaneCount;

  // Default collapse state: expanded, except any group whose lane count exceeds
  // the threshold starts collapsed. Computed once from the initial group shape;
  // user toggles thereafter own the state. The parent lane is always one lane,
  // so it never auto-collapses.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const group of groups) {
      if (group.agents.length > AUTO_COLLAPSE_LANE_THRESHOLD) {
        initial.add(subagentGroupId(group.runId));
      }
    }
    return initial;
  });

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Empty state: no subagents. But if a parent lane was supplied we still render
  // the chart so the parent activity stays visible even with zero agents.
  if (agents.length === 0 && !hasParentLane) {
    return <div className="text-ink-muted text-xs">No subagents ran in this session.</div>;
  }

  // Global lane index, incremented across the parent lane (if any) then every
  // group's agents in render order. Used (with totalLanes) to flip the tooltip
  // upward on the bottom lanes, mirroring GanttTimeline's
  // `idx >= 3 && idx > sorted.length - 4` rule. Only EXPANDED, rendered lanes
  // advance it, so the flip math tracks what's actually on screen.
  let laneIndex = -1;

  const tooltipVerticalClass = (idx: number): string =>
    idx >= 3 && idx > totalLanes - 4 ? 'bottom-full mb-1' : 'top-full mt-1';

  const parentCollapsed = collapsed.has(PARENT_GROUP_ID);

  return (
    <div className="p-2 overflow-x-hidden">
      {/* Single shared time axis for the entire chart (parent + all subagent
          groups). One axis only, aligned to the same w-24 gutter + x-scale as
          every lane below. */}
      <div className="flex">
        <div className="w-24 shrink-0" />
        <div className="relative flex-1 h-5 border-b border-bg-line overflow-x-auto">
          {ticks.map((t) => {
            const leftPct = (t / span) * 100;
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

      <div className="mt-1">
        {/* Parent activity group — a single lane drawing all parentEntries by
            absolute timestamp, sharing the gutter + x-scale with subagents. */}
        {hasParentLane && (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => toggleGroup(PARENT_GROUP_ID)}
              aria-expanded={!parentCollapsed}
              className="flex w-full items-center gap-1.5 mb-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
            >
              {parentCollapsed ? (
                <ChevronRight size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
              ) : (
                <ChevronDown size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
              )}
              <span className="text-[11px] font-medium text-ink-subtle truncate">
                Parent activity
              </span>
              <span className="text-[10px] text-ink-muted tabular-nums">
                {sortedParentEntries.length} tool call{sortedParentEntries.length === 1 ? '' : 's'}
              </span>
            </button>

            {!parentCollapsed &&
              (() => {
                laneIndex += 1;
                const idx = laneIndex;
                return (
                  <div className="flex items-center h-7">
                    <div className="w-24 shrink-0 truncate text-[11px] text-ink-subtle pr-2 text-right">
                      Parent
                    </div>
                    <div className="relative flex-1 h-full flex items-center">
                      {sortedParentEntries.map((entry, i) => {
                        const offsetMs = entry.timestamp - window.startMs;
                        const leftPct = Math.max(0, (offsetMs / span) * 100);
                        const widthPct = ((entry.durationMs ?? 50) / span) * 100;
                        const key = `parent:${i}`;
                        const display = shortToolName(entry.toolName);
                        const tooltipStyle =
                          leftPct >= 50
                            ? { right: `${Math.max(0, 100 - leftPct - widthPct)}%` }
                            : { left: `${leftPct}%` };
                        const ariaLabel =
                          `${entry.toolName} · ` +
                          `${entry.durationMs != null ? `${entry.durationMs}ms` : 'unknown'} · ` +
                          `${entry.success ? 'success' : 'failed'}`;

                        return (
                          <div key={key} className="contents">
                            <div
                              role="img"
                              aria-label={ariaLabel}
                              className={
                                `absolute inset-y-0 my-auto h-5 rounded-sm opacity-80 cursor-default ${getParentBarColor(display)} ` +
                                (entry.success ? '' : 'ring-1 ring-accent-red/60')
                              }
                              style={{
                                left: `${leftPct}%`,
                                width: `${widthPct}%`,
                                minWidth: '4px',
                              }}
                              onMouseEnter={() => setHoveredKey(key)}
                              onMouseLeave={() => setHoveredKey(null)}
                            />
                            {hoveredKey === key && (
                              <div
                                className={`absolute z-50 ${tooltipVerticalClass(idx)} px-2 py-1.5 rounded-lg bg-bg-elevated border border-bg-line text-[11px] text-ink-base shadow-lg whitespace-nowrap pointer-events-none`}
                                style={tooltipStyle}
                              >
                                <div className="font-medium">{entry.toolName}</div>
                                <div className="text-ink-muted">
                                  {entry.durationMs != null ? `${entry.durationMs}ms` : 'unknown'}{' '}
                                  &middot; {entry.success ? 'success' : 'failed'}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
          </div>
        )}

        {/* Subagent groups */}
        {groups.map((group, groupIdx) => {
          const barColor = GROUP_BAR_COLORS[groupIdx % GROUP_BAR_COLORS.length]!;
          const groupId = subagentGroupId(group.runId);
          const isCollapsed = collapsed.has(groupId);

          // One-line collapsed summary: "N agents · $X.XX · m:ss span". Null-
          // preserving so an all-null-cost group reads "—" (no data), not "$0.00".
          const groupUsdVals = group.agents.map((a) => a.usd).filter((v): v is number => v != null);
          const groupUsd = groupUsdVals.length > 0 ? groupUsdVals.reduce((x, y) => x + y, 0) : null;
          const groupSpanMs =
            group.agents.reduce((m, a) => Math.max(m, a.endMs), 0) - group.earliestStartMs;
          const summary =
            `${group.agents.length} agent${group.agents.length === 1 ? '' : 's'} · ` +
            `${formatUsdOrDash(groupUsd)} · ${fmtTickLabel(Math.max(0, groupSpanMs))} span`;

          return (
            <div key={group.runId ?? ADHOC_GROUP_ID} className="mb-2">
              {/* Group header — clickable disclosure; swatch matches this
                  group's bar color. */}
              <button
                type="button"
                onClick={() => toggleGroup(groupId)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1.5 mb-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
              >
                {isCollapsed ? (
                  <ChevronRight size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
                ) : (
                  <ChevronDown size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
                )}
                <span
                  className={`inline-block w-2 h-2 rounded-sm shrink-0 ${barColor}`}
                  aria-hidden="true"
                />
                <span
                  className="text-[11px] font-medium text-ink-subtle truncate"
                  title={group.name}
                >
                  {group.name}
                </span>
                {isCollapsed ? (
                  <span className="text-[10px] text-ink-muted tabular-nums truncate">
                    {summary}
                  </span>
                ) : (
                  <span className="text-[10px] text-ink-muted tabular-nums">
                    {group.agents.length} agent{group.agents.length === 1 ? '' : 's'}
                  </span>
                )}
              </button>

              {/* Agent lanes (hidden when collapsed) */}
              {!isCollapsed &&
                group.agents.map((agent) => {
                  laneIndex += 1;
                  const idx = laneIndex;
                  const offsetMs = agent.startMs - window.startMs;
                  const leftPct = Math.max(0, (offsetMs / span) * 100);
                  const widthPct = (agent.durationMs / span) * 100;
                  const key = `${groupIdx}:${agent.agentId}`;
                  const clickable = agent.workflowRunId !== null && onSelectRun !== undefined;
                  const runId = agent.workflowRunId;

                  // Tooltip anchors to the right edge of the bar when it starts
                  // past the midpoint, so it grows leftward and stays in-track —
                  // same horizontal flip as GanttTimeline.
                  const tooltipStyle =
                    leftPct >= 50
                      ? { right: `${Math.max(0, 100 - leftPct - widthPct)}%` }
                      : { left: `${leftPct}%` };

                  const ariaLabel =
                    `${agent.label} · ${agent.model} · ${agent.turnCount} turns · ` +
                    `${formatNumber(agent.totalTokens)} tokens · ` +
                    `${formatUsdOrDash(agent.usd)} · ` +
                    `${formatDuration(agent.durationMs)}` +
                    (clickable ? ' · open workflow run' : '');

                  const barClasses =
                    `absolute inset-y-0 my-auto h-5 rounded-sm opacity-85 ${barColor} ` +
                    (clickable
                      ? 'cursor-pointer hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40'
                      : 'cursor-default');

                  return (
                    <div key={key} className="flex items-center h-7">
                      <div
                        className="w-24 shrink-0 truncate text-[11px] text-ink-subtle pr-2 text-right"
                        title={agent.label}
                      >
                        {agent.label}
                      </div>
                      <div className="relative flex-1 h-full flex items-center">
                        {clickable ? (
                          <button
                            type="button"
                            aria-label={ariaLabel}
                            className={barClasses}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
                            onClick={() => onSelectRun!(runId!)}
                            onMouseEnter={() => setHoveredKey(key)}
                            onMouseLeave={() => setHoveredKey(null)}
                            onFocus={() => setHoveredKey(key)}
                            onBlur={() => setHoveredKey(null)}
                          />
                        ) : (
                          <div
                            role="img"
                            aria-label={ariaLabel}
                            className={barClasses}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
                            onMouseEnter={() => setHoveredKey(key)}
                            onMouseLeave={() => setHoveredKey(null)}
                          />
                        )}

                        {hoveredKey === key && (
                          <div
                            className={`absolute z-50 ${tooltipVerticalClass(idx)} px-2 py-1.5 rounded-lg bg-bg-elevated border border-bg-line text-[11px] text-ink-base shadow-lg whitespace-nowrap pointer-events-none`}
                            style={tooltipStyle}
                          >
                            <div className="font-medium">{agent.label}</div>
                            <div className="text-ink-subtle font-mono">{agent.model}</div>
                            <div className="text-ink-muted">
                              {agent.turnCount} turn{agent.turnCount === 1 ? '' : 's'} &middot;{' '}
                              {formatNumber(agent.totalTokens)} tokens
                            </div>
                            <div className="text-ink-muted">
                              {formatUsdOrDash(agent.usd)} &middot;{' '}
                              {formatDuration(agent.durationMs)}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
