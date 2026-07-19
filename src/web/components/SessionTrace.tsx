import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react';

import { fetchAgentCalls, qk, type AgentCall } from '../api/client.js';
import { GanttTimeline } from './GanttTimeline.js';
import type { AgentSpan } from './AgentSwimlanes.js';
import { Tabs } from './ui/index.js';
import {
  formatTokensCompact,
  formatDuration,
  formatUsd,
  formatUsdOrDash,
  fmtElapsed,
  shortToolName,
} from '../lib/format.js';
import {
  groupAgents,
  GROUP_BAR_COLORS,
  PARENT_GROUP_ID,
  ADHOC_GROUP_ID,
  subagentGroupId,
  fmtTickLabel as fmtSpanLabel,
  type AgentGroup,
} from '../lib/agent-groups.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A single parent (top-level) tool call. Frozen input contract — keep stable.
// Mirrors the shape GanttTimeline consumes so parentEntries pass straight
// through to the parent lane.
interface ParentEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
}

// Anti-pattern highlight spans for the PARENT lane only (thrashing, stuck loop,
// etc.), as indices into the parent entries. Mirrors GanttTimeline's segment
// shape so they pass straight through; optional so callers without segment data
// (e.g. the Sessions view) simply omit them.
interface ParentSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly severity: 'warning' | 'critical';
}

export interface SessionTraceProps {
  readonly sessionId: string;
  readonly parentEntries: ReadonlyArray<ParentEntry>;
  readonly agents: ReadonlyArray<AgentSpan>;
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly onSelectRun?: (runId: string) => void;
  // Optional workflow-run status lookup keyed by runId →
  // 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'. When omitted
  // (or a runId is missing), no status indicator is drawn — the trace renders
  // exactly as before. Additive only; never changes layout when absent.
  readonly runStatusById?: Record<string, string>;
  // Optional anti-pattern highlight spans for the parent lane, threaded straight
  // through to the parent gantt. Omitted by callers without segment data.
  readonly parentSegments?: ReadonlyArray<ParentSegment>;
}

// Groups with more than this many agents start collapsed so the trace doesn't
// open at an unreasonable height. Users can still expand them. Drives the
// INITIAL collapse state only — the segmented control overrides it wholesale.
const AUTO_COLLAPSE_AGENT_THRESHOLD = 15;

// Shared left-gutter width for EVERY chart row the trace draws — the persistent
// axis spacer, collapsed-group bars, agent-span rows, and every GanttTimeline
// it renders (parent lane + nested agent calls). A single source of truth keeps
// all bars column-aligned under the one axis. Wider than the standalone w-24
// default so longer agent labels (e.g. "investigate:…") don't truncate badly.
const TRACE_GUTTER = 'w-44';

// Three-level expand/collapse preset for the segmented control.
type TraceLevel = 'collapsed' | 'agents' | 'expanded';

// ---------------------------------------------------------------------------
// Workflow-run status indicator. Maps a status
// string to a small lucide icon with a semantic accent. Returns null for
// unknown / missing / ad-hoc (no runId) so the layout is unchanged when status
// data is absent.
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { readonly status: string | undefined }): JSX.Element | null {
  if (status === 'completed') {
    return (
      <CheckCircle2
        size={12}
        className="shrink-0 text-accent-green"
        aria-label="completed"
        role="img"
      />
    );
  }
  if (status === 'failed') {
    return (
      <XCircle size={12} className="shrink-0 text-accent-red" aria-label="failed" role="img" />
    );
  }
  if (status === 'running') {
    return (
      <Loader2
        size={12}
        className="shrink-0 text-accent-cyan animate-spin"
        aria-label="running"
        role="img"
      />
    );
  }
  if (status === 'cancelled') {
    return (
      <Clock size={12} className="shrink-0 text-accent-amber" aria-label="cancelled" role="img" />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SessionTrace({
  sessionId,
  parentEntries,
  agents,
  window,
  onSelectRun,
  runStatusById,
  parentSegments,
}: SessionTraceProps): JSX.Element {
  const [viewMode, setViewMode] = useState<'gantt' | 'list'>('gantt');

  const groups = useMemo(() => groupAgents(agents), [agents]);

  // Every collapsible group id (parent sentinel + each subagent group) and every
  // agentId — used to drive the segmented control's wholesale set/clear and the
  // initial auto-collapse.
  const allGroupIds = useMemo<string[]>(() => {
    const ids: string[] = [];
    if (parentEntries.length > 0) ids.push(PARENT_GROUP_ID);
    for (const group of groups) ids.push(subagentGroupId(group.runId));
    return ids;
  }, [groups, parentEntries.length]);

  const allAgentIds = useMemo<string[]>(() => agents.map((a) => a.agentId), [agents]);

  // SHARED collapse model lifted to the top so gantt + list stay in lockstep.
  //  - collapsedGroups: group ids (incl. PARENT_GROUP_ID) whose disclosure is shut.
  //  - expandedAgents: agentIds whose per-agent CALLS drill-in is open.
  // Initial state: groups over the threshold start collapsed (per-group), no
  // agent calls expanded. The segmented control overrides both wholesale.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const group of groups) {
      if (group.agents.length > AUTO_COLLAPSE_AGENT_THRESHOLD) {
        initial.add(subagentGroupId(group.runId));
      }
    }
    return initial;
  });
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => new Set<string>());

  const toggleGroup = (id: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAgent = (agentId: string): void => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  // Apply a three-level preset wholesale. Collapsed → every group shut, no
  // agent calls open. Agents → every group open, no agent calls open. Expand
  // all → every group open AND every agent's calls open (lazy queries are
  // cached so opening them all is cheap on repeat).
  const applyLevel = (level: TraceLevel): void => {
    if (level === 'collapsed') {
      setCollapsedGroups(new Set(allGroupIds));
      setExpandedAgents(new Set<string>());
    } else if (level === 'agents') {
      // Parent holds raw tool calls, not agents/workflows — keep it collapsed so
      // "Agents" reveals only the workflow/subagent groups, never the parent's
      // (often thousands of) tool-call rows.
      setCollapsedGroups(
        parentEntries.length > 0 ? new Set<string>([PARENT_GROUP_ID]) : new Set<string>(),
      );
      setExpandedAgents(new Set<string>());
    } else {
      setCollapsedGroups(new Set<string>());
      setExpandedAgents(new Set(allAgentIds));
    }
  };

  // Reflect the current sets back to a level for aria-pressed. "collapsed" when
  // every group is shut and no agent is expanded; "expanded" when no group is
  // collapsed AND every agent's calls are open; "agents" when the parent is
  // shut, every subagent group is open, and no agent is expanded (see below).
  // When the state matches none of the presets (mixed manual toggling), no
  // button reads as pressed.
  const activeLevel = useMemo<TraceLevel | null>(() => {
    const hasParent = parentEntries.length > 0;
    const subagentGroupIds = allGroupIds.filter((id) => id !== PARENT_GROUP_ID);
    const parentShut = !hasParent || collapsedGroups.has(PARENT_GROUP_ID);
    const noGroupsCollapsed = collapsedGroups.size === 0;
    const allGroupsCollapsed =
      allGroupIds.length > 0 && allGroupIds.every((id) => collapsedGroups.has(id));
    const allSubagentGroupsOpen = subagentGroupIds.every((id) => !collapsedGroups.has(id));
    const noAgentsExpanded = expandedAgents.size === 0;
    const allAgentsExpanded =
      allAgentIds.length > 0
        ? allAgentIds.every((id) => expandedAgents.has(id))
        : expandedAgents.size === 0;

    if (allGroupsCollapsed && noAgentsExpanded) return 'collapsed';
    if (noGroupsCollapsed && allAgentsExpanded) return 'expanded';
    // "Agents": parent's tool calls hidden, every subagent group open, no
    // per-agent calls drilled in.
    if (parentShut && allSubagentGroupsOpen && noAgentsExpanded) return 'agents';
    return null;
  }, [collapsedGroups, expandedAgents, allGroupIds, allAgentIds, parentEntries.length]);

  const totalCalls = parentEntries.length;

  // Mutable copy of parentEntries for GanttTimeline (its props type is a
  // mutable array; the component never mutates, it sorts a local copy).
  const parentRows = useMemo<ParentEntry[]>(() => [...parentEntries], [parentEntries]);

  // Empty state: nothing to show at all.
  if (parentEntries.length === 0 && agents.length === 0) {
    return <div className="text-ink-muted text-xs">No activity recorded.</div>;
  }

  return (
    <div>
      {/* Header: Gantt/List toggle + expand-level control + call count. */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Tabs<'gantt' | 'list'>
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'gantt', label: 'Gantt' },
              { value: 'list', label: 'List' },
            ]}
            size="sm"
            tone="green"
            ariaLabel="Session trace view mode"
          />
          <div className="h-4 w-px bg-border-subtle" aria-hidden="true" />
          <LevelControl active={activeLevel} onSelect={applyLevel} />
        </div>
        <span className="text-[10px] uppercase tracking-wider text-ink-muted tabular-nums">
          {totalCalls} parent call{totalCalls === 1 ? '' : 's'} · {agents.length} agent
          {agents.length === 1 ? '' : 's'}
        </span>
      </div>

      {viewMode === 'gantt' ? (
        <GanttView
          parentRows={parentRows}
          groups={groups}
          window={window}
          sessionId={sessionId}
          onSelectRun={onSelectRun}
          runStatusById={runStatusById}
          parentSegments={parentSegments}
          collapsedGroups={collapsedGroups}
          toggleGroup={toggleGroup}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
        />
      ) : (
        <ListView
          parentRows={parentRows}
          groups={groups}
          window={window}
          sessionId={sessionId}
          onSelectRun={onSelectRun}
          runStatusById={runStatusById}
          collapsedGroups={collapsedGroups}
          toggleGroup={toggleGroup}
          expandedAgents={expandedAgents}
          toggleAgent={toggleAgent}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control — three presets driving the SHARED collapse model. A small
// accessible button group; the matching preset reads aria-pressed. Matches the
// existing text-[10px]/[11px] sizing and design tokens.
// ---------------------------------------------------------------------------

function LevelControl({
  active,
  onSelect,
}: {
  readonly active: TraceLevel | null;
  readonly onSelect: (level: TraceLevel) => void;
}): JSX.Element {
  const options: ReadonlyArray<{ readonly value: TraceLevel; readonly label: string }> = [
    { value: 'collapsed', label: 'Collapsed' },
    { value: 'agents', label: 'Agents' },
    { value: 'expanded', label: 'Expand all' },
  ];

  return (
    <div role="group" aria-label="Trace expand level" className="inline-flex items-center gap-1">
      {options.map((opt) => {
        const isActive = active === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(opt.value)}
            className={
              `px-2 py-0.5 text-[10px] rounded-md transition-colors ` +
              `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 ` +
              (isActive
                ? 'bg-accent-cyan/20 text-accent-cyan font-medium'
                : 'text-ink-muted hover:text-ink-subtle')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared view props — both Gantt and List receive the SAME collapse model so
// the two modes (and the segmented control) stay in lockstep.
// ---------------------------------------------------------------------------

interface ViewProps {
  readonly parentRows: ParentEntry[];
  readonly groups: AgentGroup[];
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly sessionId: string;
  readonly onSelectRun?: (runId: string) => void;
  readonly runStatusById?: Record<string, string>;
  readonly parentSegments?: ReadonlyArray<ParentSegment>;
  readonly collapsedGroups: Set<string>;
  readonly toggleGroup: (id: string) => void;
  readonly expandedAgents: Set<string>;
  readonly toggleAgent: (agentId: string) => void;
}

// ---------------------------------------------------------------------------
// Persistent shared time axis. Rendered ONCE at the very top of the
// gantt, always visible regardless of collapse state. Same tick algorithm as
// GanttTimeline (target ~8 ticks; candidate intervals, fall back to
// ceil(total/8)) and the same TRACE_GUTTER so labels align with every bar.
// ---------------------------------------------------------------------------

function TraceAxis({
  window,
}: {
  readonly window: { readonly startMs: number; readonly endMs: number };
}): JSX.Element {
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

  return (
    <div className="flex px-2">
      <div className={`${TRACE_GUTTER} shrink-0`} />
      <div className="relative flex-1 h-5 border-b border-bg-line overflow-x-auto">
        {ticks.map((t) => {
          const leftPct = (t / span) * 100;
          return (
            <span
              key={t}
              className="absolute top-0 text-[9px] text-ink-muted tabular-nums -translate-x-1/2"
              style={{ left: `${leftPct}%` }}
            >
              {fmtSpanLabel(t)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gantt mode — one shared absolute time axis (window) and a single TRACE_GUTTER
// gutter. The axis is now drawn ONCE at the top by TraceAxis (above Parent),
// always visible; every GanttTimeline below uses showTicks={false} and shares
// the same window/gutter so all rows line up vertically.
// ---------------------------------------------------------------------------

function GanttView({
  parentRows,
  groups,
  window,
  sessionId,
  onSelectRun,
  runStatusById,
  parentSegments,
  collapsedGroups,
  toggleGroup,
  expandedAgents,
  toggleAgent,
}: ViewProps): JSX.Element {
  const parentCollapsed = collapsedGroups.has(PARENT_GROUP_ID);
  const hasParent = parentRows.length > 0;

  return (
    <div className="overflow-x-hidden">
      {/* Persistent shared axis — outside every collapsible group so it stays
          visible no matter what is collapsed. */}
      <TraceAxis window={window} />

      {/* Parent group — header + (when expanded) the parent lane, ticks OFF
          (the axis above owns the only ticks now). */}
      {hasParent && (
        <div className="mb-2 mt-1">
          <GroupHeader
            collapsed={parentCollapsed}
            onToggle={() => toggleGroup(PARENT_GROUP_ID)}
            label="Parent"
            count={`${parentRows.length} tool call${parentRows.length === 1 ? '' : 's'}`}
          />
          {!parentCollapsed && (
            <GanttTimeline
              entries={parentRows}
              segments={parentSegments ? [...parentSegments] : []}
              windowStartMs={window.startMs}
              windowEndMs={window.endMs}
              showTicks={false}
              gutterClass={TRACE_GUTTER}
            />
          )}
        </div>
      )}

      {/* Subagent groups. */}
      {groups.map((group, groupIdx) => {
        const barColor = GROUP_BAR_COLORS[groupIdx % GROUP_BAR_COLORS.length]!;
        const groupId = subagentGroupId(group.runId);
        const isCollapsed = collapsedGroups.has(groupId);
        const status = group.runId !== null ? runStatusById?.[group.runId] : undefined;
        const openRun =
          group.runId !== null && onSelectRun ? () => onSelectRun(group.runId!) : undefined;

        // Null-preserving: a group whose agents all lack cost data renders "—"
        // (no data), not "$0.00" — matching the list-view rollup below and
        // keeping the no-data/measured-zero distinction intact.
        const groupUsdVals = group.agents.map((a) => a.usd).filter((v): v is number => v != null);
        const groupUsd = groupUsdVals.length > 0 ? groupUsdVals.reduce((x, y) => x + y, 0) : null;
        const groupEndMs = group.agents.reduce((m, a) => Math.max(m, a.endMs), 0);
        const groupSpanMs = groupEndMs - group.earliestStartMs;
        const summary =
          `${group.agents.length} agent${group.agents.length === 1 ? '' : 's'} · ` +
          `${formatUsdOrDash(groupUsd)} · ${fmtSpanLabel(Math.max(0, groupSpanMs))} span`;

        return (
          <div key={group.runId ?? ADHOC_GROUP_ID} className="mb-2">
            {isCollapsed ? (
              <CollapsedGroupBar
                onToggle={() => toggleGroup(groupId)}
                label={group.name}
                summary={summary}
                barColor={barColor}
                window={window}
                startMs={group.earliestStartMs}
                endMs={groupEndMs}
                status={status}
                onOpenRun={openRun}
              />
            ) : (
              <>
                <GroupHeader
                  collapsed={false}
                  onToggle={() => toggleGroup(groupId)}
                  label={group.name}
                  swatchColor={barColor}
                  count={`${group.agents.length} agent${group.agents.length === 1 ? '' : 's'}`}
                  status={status}
                  onOpenRun={openRun}
                />
                {group.agents.map((agent) => (
                  <AgentGanttRow
                    key={agent.agentId}
                    agent={agent}
                    barColor={barColor}
                    window={window}
                    sessionId={sessionId}
                    onSelectRun={onSelectRun}
                    expanded={expandedAgents.has(agent.agentId)}
                    onToggle={() => toggleAgent(agent.agentId)}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// A collapsed subagent group: a header ROW with the shared gutter (chevron +
// swatch + truncated name + status) on the left and a track (flex-1) holding a
// single span bar positioned in the shared window, colored with the group's
// series color. Lets the user see WHERE in time each workflow was active —
// overlapping bars = parallel, disjoint = sequential — without expanding. A
// FAILED group additionally gets a red ring on the bar (fill stays the series
// color = category; ring = failure, mirroring GanttTimeline's !success ring).
function CollapsedGroupBar({
  onToggle,
  label,
  summary,
  barColor,
  window,
  startMs,
  endMs,
  status,
  onOpenRun,
}: {
  readonly onToggle: () => void;
  readonly label: string;
  readonly summary: string;
  readonly barColor: string;
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly startMs: number;
  readonly endMs: number;
  readonly status: string | undefined;
  readonly onOpenRun?: () => void;
}): JSX.Element {
  const span = Math.max(window.endMs - window.startMs, 1);
  const offsetMs = startMs - window.startMs;
  const leftPct = Math.max(0, (offsetMs / span) * 100);
  const widthPct = (Math.max(0, endMs - startMs) / span) * 100;

  const barTitle = `${label} · ${summary}`;
  const failed = status === 'failed';
  const barClasses =
    `absolute inset-y-0 my-auto h-4 rounded-sm opacity-85 ${barColor}` +
    (failed ? ' ring-1 ring-accent-red/60' : '');

  return (
    <div className="flex items-center h-7 px-2">
      <div className={`${TRACE_GUTTER} shrink-0 flex items-center gap-1.5 pr-2`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
          title={summary}
        >
          <ChevronRight size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
          <span
            className={`inline-block w-2 h-2 rounded-sm shrink-0 ${barColor}`}
            aria-hidden="true"
          />
        </button>
        {onOpenRun ? (
          <span
            role="button"
            tabIndex={0}
            title={`${label} · open run`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRun();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onOpenRun();
              }
            }}
            className="text-[11px] font-medium text-ink-subtle truncate cursor-pointer hover:text-accent-cyan hover:underline underline-offset-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
          >
            {label}
          </span>
        ) : (
          <span className="text-[11px] font-medium text-ink-subtle truncate" title={label}>
            {label}
          </span>
        )}
        <StatusIcon status={status} />
      </div>
      <div className="relative flex-1 h-full flex items-center">
        <div
          role="img"
          aria-label={barTitle}
          title={barTitle}
          className={barClasses}
          style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
        />
      </div>
    </div>
  );
}

// A subagent's SPAN as a single bar on the shared axis, plus a nested
// disclosure that lazy-fetches and renders that agent's individual tool calls
// as a ticks-off GanttTimeline indented beneath it. Expansion is driven by the
// SHARED expandedAgents set so it stays in lockstep with list mode.
function AgentGanttRow({
  agent,
  barColor,
  window,
  sessionId,
  onSelectRun,
  expanded,
  onToggle,
}: {
  readonly agent: AgentSpan;
  readonly barColor: string;
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly sessionId: string;
  readonly onSelectRun?: (runId: string) => void;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const [hovered, setHovered] = useState(false);

  const span = Math.max(window.endMs - window.startMs, 1);
  const offsetMs = agent.startMs - window.startMs;
  const leftPct = Math.max(0, (offsetMs / span) * 100);
  const widthPct = (agent.durationMs / span) * 100;

  const clickable = agent.workflowRunId !== null && onSelectRun !== undefined;
  const runId = agent.workflowRunId;

  const tooltipStyle =
    leftPct >= 50
      ? { right: `${Math.max(0, 100 - leftPct - widthPct)}%` }
      : { left: `${leftPct}%` };

  const ariaLabel =
    `${agent.label} · ${agent.model} · ${agent.turnCount} turns · ` +
    `${formatTokensCompact(agent.totalTokens)} tokens · ` +
    `${formatUsdOrDash(agent.usd)} · ` +
    `${formatDuration(agent.durationMs)}` +
    (clickable ? ' · open workflow run' : '');

  const barClasses =
    `absolute inset-y-0 my-auto h-5 rounded-sm opacity-85 ${barColor} ` +
    (clickable
      ? 'cursor-pointer hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40'
      : 'cursor-default');

  return (
    <div>
      {/* Agent span row: gutter holds a calls-disclosure chevron + label;
          track holds the single span bar positioned in the shared window. The
          px-2 inset matches TraceAxis + GanttTimeline so the span bar's left/
          width percentages map onto the same track as the axis ticks above. */}
      <div className="flex items-center h-7 px-2">
        <div className={`${TRACE_GUTTER} shrink-0 flex items-center gap-1 pl-4 pr-2`}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} calls for ${agent.label}`}
            className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
          >
            {expanded ? (
              <ChevronDown size={11} className="text-ink-muted" aria-hidden="true" />
            ) : (
              <ChevronRight size={11} className="text-ink-muted" aria-hidden="true" />
            )}
          </button>
          <span className="truncate text-[11px] text-ink-subtle" title={agent.label}>
            {agent.label}
          </span>
        </div>
        <div className="relative flex-1 h-full flex items-center">
          {clickable ? (
            <button
              type="button"
              aria-label={ariaLabel}
              className={barClasses}
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
              onClick={() => onSelectRun!(runId!)}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setHovered(true)}
              onBlur={() => setHovered(false)}
            />
          ) : (
            <div
              role="img"
              aria-label={ariaLabel}
              className={barClasses}
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            />
          )}

          {hovered && (
            <div
              className="absolute z-50 top-full mt-1 px-2 py-1.5 rounded-lg bg-bg-elevated border border-bg-line text-[11px] text-ink-base shadow-lg whitespace-nowrap pointer-events-none"
              style={tooltipStyle}
            >
              <div className="font-medium">{agent.label}</div>
              <div className="text-ink-subtle font-mono">{agent.model}</div>
              <div className="text-ink-muted">
                {agent.turnCount} turn{agent.turnCount === 1 ? '' : 's'} &middot;{' '}
                {formatTokensCompact(agent.totalTokens)} tokens
              </div>
              <div className="text-ink-muted">
                {formatUsdOrDash(agent.usd)} &middot; {formatDuration(agent.durationMs)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Nested calls — mounted only when expanded, so the lazy query fires on
          first expand. Same shared window + gutter, ticks OFF (the persistent
          axis owns the only ticks). */}
      {expanded && (
        <AgentCallsGantt agentId={agent.agentId} sessionId={sessionId} window={window} />
      )}
    </div>
  );
}

// Mounts on expand → the useQuery below fires its first fetch lazily. Renders
// the agent's calls as a ticks-off gantt on the shared window + gutter.
function AgentCallsGantt({
  agentId,
  sessionId,
  window,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly window: { readonly startMs: number; readonly endMs: number };
}): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.agentCalls(sessionId, agentId),
    queryFn: () => fetchAgentCalls(sessionId, agentId),
    retry: false,
  });

  if (isLoading) {
    return <div className="pl-6 py-1 text-[10px] text-ink-muted">Loading calls…</div>;
  }
  if (isError) {
    return <div className="pl-6 py-1 text-[10px] text-accent-red">Failed to load calls.</div>;
  }

  const calls = data?.calls ?? [];
  if (calls.length === 0) {
    return <div className="pl-6 py-1 text-[10px] text-ink-muted">No calls recorded.</div>;
  }

  return (
    <div className="pl-3 border-l border-bg-line ml-3">
      <GanttTimeline
        entries={[...calls]}
        segments={[]}
        windowStartMs={window.startMs}
        windowEndMs={window.endMs}
        showTicks={false}
        gutterClass={TRACE_GUTTER}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List mode — a hierarchical tree using the SAME shared collapse model as the
// gantt: Parent section collapsible, each subagent group collapsible, and
// per-agent call expansion driven by the shared expandedAgents set. Compact.
// ---------------------------------------------------------------------------

function ListView({
  parentRows,
  groups,
  window,
  sessionId,
  onSelectRun,
  runStatusById,
  collapsedGroups,
  toggleGroup,
  expandedAgents,
  toggleAgent,
}: ViewProps): JSX.Element {
  const firstTs = window.startMs;
  const parentCollapsed = collapsedGroups.has(PARENT_GROUP_ID);

  // Wall-clock span of the parent's own tool calls (first start → last end).
  // Parent calls carry no per-call tokens/cost, so the parent rollup shows time
  // only; the workflow/ad-hoc groups below roll up turns/tokens/cost/time.
  const parentSpanMs = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const e of parentRows) {
      if (e.timestamp < min) min = e.timestamp;
      const end = e.timestamp + (e.durationMs ?? 50);
      if (end > max) max = end;
    }
    return Number.isFinite(min) ? Math.max(0, max - min) : 0;
  }, [parentRows]);

  return (
    <div className="text-[11px]">
      {/* Parent calls — now a collapsible disclosure matching the gantt. */}
      {parentRows.length > 0 && (
        <div className="mb-3">
          <GroupHeader
            collapsed={parentCollapsed}
            onToggle={() => toggleGroup(PARENT_GROUP_ID)}
            label="Parent"
            count={`${parentRows.length} tool call${parentRows.length === 1 ? '' : 's'}`}
            trailing={<RollupMetrics durationMs={parentSpanMs} />}
          />
          {!parentCollapsed && (
            <div className="flex flex-col">
              {[...parentRows]
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((entry, idx) => (
                  <CallListRow
                    key={`${idx}-${entry.timestamp}`}
                    entry={entry}
                    firstTs={firstTs}
                    detail={entry.filePath ?? entry.command ?? ''}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* Subagent groups — each collapsible, with status on the header. */}
      {groups.map((group, groupIdx) => {
        const barColor = GROUP_BAR_COLORS[groupIdx % GROUP_BAR_COLORS.length]!;
        const groupId = subagentGroupId(group.runId);
        const isCollapsed = collapsedGroups.has(groupId);
        const status = group.runId !== null ? runStatusById?.[group.runId] : undefined;
        const openRun =
          group.runId !== null && onSelectRun ? () => onSelectRun(group.runId!) : undefined;

        const groupTurns = group.agents.reduce((sum, a) => sum + a.turnCount, 0);
        const groupTokens = group.agents.reduce((sum, a) => sum + a.totalTokens, 0);
        const groupUsdVals = group.agents.map((a) => a.usd).filter((v): v is number => v != null);
        const groupUsd = groupUsdVals.length > 0 ? groupUsdVals.reduce((x, y) => x + y, 0) : null;
        const groupSpanMs = Math.max(
          0,
          group.agents.reduce((m, a) => Math.max(m, a.endMs), 0) - group.earliestStartMs,
        );

        return (
          <div key={group.runId ?? ADHOC_GROUP_ID} className="mb-3">
            <GroupHeader
              collapsed={isCollapsed}
              onToggle={() => toggleGroup(groupId)}
              label={group.name}
              swatchColor={barColor}
              count={`${group.agents.length} agent${group.agents.length === 1 ? '' : 's'}`}
              status={status}
              onOpenRun={openRun}
              trailing={
                <RollupMetrics
                  turns={groupTurns}
                  tokens={groupTokens}
                  usd={groupUsd}
                  durationMs={groupSpanMs}
                />
              }
            />
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5">
                {group.agents.map((agent) => (
                  <AgentListRow
                    key={agent.agentId}
                    agent={agent}
                    window={window}
                    sessionId={sessionId}
                    onSelectRun={onSelectRun}
                    expanded={expandedAgents.has(agent.agentId)}
                    onToggle={() => toggleAgent(agent.agentId)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One parent/agent-call row in list mode.
function CallListRow({
  entry,
  firstTs,
  detail,
}: {
  readonly entry: ParentEntry | AgentCall;
  readonly firstTs: number;
  readonly detail?: string;
}): JSX.Element {
  const elapsed = Math.max(0, entry.timestamp - firstTs);
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5">
      <span className="w-10 text-ink-muted tabular-nums shrink-0">+{fmtElapsed(elapsed)}</span>
      <span className="w-28 truncate font-medium text-ink-base shrink-0" title={entry.toolName}>
        {shortToolName(entry.toolName)}
      </span>
      <span className="flex-1 truncate font-mono text-ink-subtle min-w-0" title={detail ?? ''}>
        {detail ?? ''}
      </span>
      <span className="w-14 text-right tabular-nums text-ink-muted shrink-0">
        {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
      </span>
      <span
        className={`w-3 text-center shrink-0 ${entry.success ? 'text-accent-green' : 'text-accent-red'}`}
        aria-label={entry.success ? 'success' : 'failed'}
      >
        {entry.success ? '✓' : '✗'}
      </span>
    </div>
  );
}

// An agent in list mode: a clickable disclosure header with summary metrics,
// expanding to its lazily-fetched calls as nested rows. Expansion is driven by
// the SHARED expandedAgents set so it stays in lockstep with gantt mode.
function AgentListRow({
  agent,
  window,
  sessionId,
  onSelectRun,
  expanded,
  onToggle,
}: {
  readonly agent: AgentSpan;
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly sessionId: string;
  readonly onSelectRun?: (runId: string) => void;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const clickable = agent.workflowRunId !== null && onSelectRun !== undefined;
  const runId = agent.workflowRunId;

  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} calls for ${agent.label}`}
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
        >
          {expanded ? (
            <ChevronDown size={11} className="text-ink-muted" aria-hidden="true" />
          ) : (
            <ChevronRight size={11} className="text-ink-muted" aria-hidden="true" />
          )}
        </button>
        {clickable ? (
          <button
            type="button"
            onClick={() => onSelectRun!(runId!)}
            className="truncate font-medium text-accent-cyan hover:underline text-left shrink-0 max-w-[160px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
            title={`${agent.label} · open workflow run`}
          >
            {agent.label}
          </button>
        ) : (
          <span
            className="truncate font-medium text-ink-base shrink-0 max-w-[160px]"
            title={agent.label}
          >
            {agent.label}
          </span>
        )}
        <span className="font-mono text-ink-muted truncate min-w-0 flex-1" title={agent.model}>
          {agent.model}
        </span>
        <span className="text-ink-muted tabular-nums shrink-0">
          {agent.turnCount} turn{agent.turnCount === 1 ? '' : 's'}
        </span>
        <span className="text-ink-muted tabular-nums shrink-0">
          {formatTokensCompact(agent.totalTokens)} tok
        </span>
        <span className="text-accent-amber tabular-nums shrink-0 w-12 text-right">
          {formatUsdOrDash(agent.usd)}
        </span>
        <span className="text-ink-muted tabular-nums shrink-0 w-12 text-right">
          {formatDuration(agent.durationMs)}
        </span>
      </div>

      {expanded && (
        <AgentCallsList agentId={agent.agentId} sessionId={sessionId} firstTs={window.startMs} />
      )}
    </div>
  );
}

// Lazily-fetched agent calls as nested list rows. Mounts on expand → query
// fires lazily on first open.
function AgentCallsList({
  agentId,
  sessionId,
  firstTs,
}: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly firstTs: number;
}): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.agentCalls(sessionId, agentId),
    queryFn: () => fetchAgentCalls(sessionId, agentId),
    retry: false,
  });

  if (isLoading) {
    return <div className="pl-9 py-1 text-[10px] text-ink-muted">Loading calls…</div>;
  }
  if (isError) {
    return <div className="pl-9 py-1 text-[10px] text-accent-red">Failed to load calls.</div>;
  }

  const calls = data?.calls ?? [];
  if (calls.length === 0) {
    return <div className="pl-9 py-1 text-[10px] text-ink-muted">No calls recorded.</div>;
  }

  return (
    <div className="pl-6 border-l border-bg-line ml-3 flex flex-col">
      {[...calls]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((call, idx) => (
          <CallListRow key={`${idx}-${call.timestamp}`} entry={call} firstTs={firstTs} />
        ))}
    </div>
  );
}

// Compact rolled-up metrics cluster shown on the right of a List-mode group or
// parent header — mirrors the per-agent row columns (turns · tokens · cost ·
// time). Only the provided fields render, so the Parent line (no per-call
// tokens/cost) can show just its time span.
function RollupMetrics({
  turns,
  tokens,
  usd,
  durationMs,
}: {
  readonly turns?: number;
  readonly tokens?: number;
  readonly usd?: number | null;
  readonly durationMs?: number;
}): JSX.Element {
  return (
    <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums shrink-0 pl-2">
      {turns != null && (
        <span className="text-ink-muted">
          {turns} turn{turns === 1 ? '' : 's'}
        </span>
      )}
      {tokens != null && <span className="text-ink-muted">{formatTokensCompact(tokens)} tok</span>}
      {usd != null && <span className="text-accent-amber">{formatUsd(usd)}</span>}
      {durationMs != null && <span className="text-ink-muted">{formatDuration(durationMs)}</span>}
    </span>
  );
}

// Shared collapsible group header used by both views (parent + subagent
// groups). Accessible <button> with aria-expanded and a lucide chevron. An
// optional workflow-run status icon renders after the count when supplied.
function GroupHeader({
  collapsed,
  onToggle,
  label,
  count,
  swatchColor,
  status,
  trailing,
  onOpenRun,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly label: string;
  readonly count: string;
  readonly swatchColor?: string;
  readonly status?: string;
  readonly trailing?: JSX.Element;
  // When set (workflow groups with a runId), the label becomes an open-run
  // target; the chevron still toggles collapse. Omitted for the parent / ad-hoc.
  readonly onOpenRun?: () => void;
}): JSX.Element {
  return (
    <div className="flex w-full items-center gap-1.5 mb-0.5 px-2 text-left">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
      >
        {collapsed ? (
          <ChevronRight size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronDown size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        {swatchColor != null && (
          <span
            className={`inline-block w-2 h-2 rounded-sm shrink-0 ${swatchColor}`}
            aria-hidden="true"
          />
        )}
      </button>
      {onOpenRun ? (
        <span
          role="button"
          tabIndex={0}
          title={`${label} · open run`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenRun();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onOpenRun();
            }
          }}
          className="text-[11px] font-medium text-ink-subtle truncate min-w-0 cursor-pointer hover:text-accent-cyan hover:underline underline-offset-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
        >
          {label}
        </span>
      ) : (
        <span className="text-[11px] font-medium text-ink-subtle truncate min-w-0" title={label}>
          {label}
        </span>
      )}
      <span className="text-[10px] text-ink-muted tabular-nums truncate shrink-0">{count}</span>
      <StatusIcon status={status} />
      {trailing}
    </div>
  );
}
