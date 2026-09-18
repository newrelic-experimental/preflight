import type { DecisionTreeResponse, TurnCostsResponse } from '../api/client';
import { fmtDateTime, formatDuration, formatUsd } from './format';

// Structural subset of the Today view's SessionSummary — declared here so this
// module does not import from a view.
export interface ExportableSession {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly startTime?: number;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly antiPatterns?: ReadonlyArray<{ readonly type: string; readonly count?: number }>;
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
  readonly toolBreakdown?: Record<string, number>;
}

export interface SessionExportInput {
  readonly session: ExportableSession;
  readonly decisionTree?: DecisionTreeResponse;
  readonly turnCosts?: TurnCostsResponse;
}

const TOP_N = 3;

function topEntries(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
}

/**
 * Short Markdown block for pasting into a standup note, PR description or bug
 * report. Lines whose data is missing are left out, so the block never shows
 * placeholder values.
 */
export function sessionToMarkdown({
  session,
  decisionTree,
  turnCosts,
}: SessionExportInput): string {
  const lines: string[] = [`### Session: ${session.sessionName || session.sessionId.slice(0, 8)}`];

  if (session.startTime != null) {
    const duration = session.durationMs != null ? ` (${formatDuration(session.durationMs)})` : '';
    lines.push(`- Started: ${fmtDateTime(session.startTime)}${duration}`);
  }

  const cost = session.estimatedCostUsd ?? turnCosts?.totalAttributedCost;
  if (cost != null) lines.push(`- Estimated cost: ${formatUsd(cost)}`);

  if (session.toolCallCount != null && session.toolCallCount > 0) {
    const breakdown =
      session.toolBreakdown && Object.keys(session.toolBreakdown).length > 0
        ? ` (${topEntries(session.toolBreakdown)})`
        : '';
    lines.push(`- Tool calls: ${session.toolCallCount}${breakdown}`);
  }

  if (session.toolSuccessRate != null) {
    lines.push(`- Tool success rate: ${Math.round(session.toolSuccessRate * 100)}%`);
  }

  const models = new Set<string>();
  if (session.model) models.add(session.model);
  for (const turn of turnCosts?.turns ?? []) if (turn.model) models.add(turn.model);
  if (models.size > 0) lines.push(`- Models: ${[...models].join(', ')}`);

  if (decisionTree && decisionTree.totalBranches > 0) {
    lines.push(`- Longest failure streak: ${decisionTree.longestFailureStreak}`);
  }

  const patternCounts: Record<string, number> = {};
  for (const p of session.antiPatterns ?? []) {
    patternCounts[p.type] = (patternCounts[p.type] ?? 0) + (p.count ?? 1);
  }
  if (Object.keys(patternCounts).length > 0) {
    lines.push(`- Top anti-patterns: ${topEntries(patternCounts)}`);
  }

  return lines.join('\n');
}

/** The session summary object as fetched, pretty-printed. */
export function sessionToJson({ session }: SessionExportInput): string {
  return JSON.stringify(session, null, 2);
}

/**
 * Deep link to the session in the Sessions view, which selects it from the
 * `?id=` query parameter.
 */
export function sessionLink(origin: string, sessionId: string): string {
  return `${origin}/sessions?id=${encodeURIComponent(sessionId)}`;
}
