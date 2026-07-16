import type { AgentSpan } from '../api/client.js';

export interface AgentGroup {
  readonly runId: string | null;
  readonly name: string;
  readonly earliestStartMs: number;
  readonly agents: AgentSpan[];
}

// Group agents by workflowRunId. Null runId agents collapse into a single
// "Ad-hoc subagents" group. Groups are sorted by their earliest agent start.
// Shared by AgentSwimlanes.tsx and SessionTrace.tsx so both charts agree on
// how subagents bucket by workflow run.
export function groupAgents(agents: ReadonlyArray<AgentSpan>): AgentGroup[] {
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

// Cycle the dedicated categorical "series" ramp, one hue per workflow group.
// These tokens carry no semantic meaning (unlike green=success / red=danger);
// the swatch reads as a CATEGORY. Index is the group's sorted position.
export const GROUP_BAR_COLORS = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
] as const;

// Stable group id used to key collapse state. The parent lane gets a reserved
// id; subagent groups key off their runId (with a fixed token for the ad-hoc
// null-runId group). Stable across re-renders so a user's expand/collapse
// choice sticks even as data refreshes.
export const PARENT_GROUP_ID = '__parent__';
export const ADHOC_GROUP_ID = '__adhoc__';

export function subagentGroupId(runId: string | null): string {
  return runId === null ? ADHOC_GROUP_ID : `run:${runId}`;
}

// mm:ss relative to the window start — shared axis style for both charts.
export function fmtTickLabel(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}
