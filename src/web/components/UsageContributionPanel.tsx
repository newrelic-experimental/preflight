import type { JSX } from 'react';
import { Link } from 'wouter';

import { EmptyState } from './EmptyState';
import { ShareTable } from './ShareTable';
import { UsageInsightsList } from './UsageInsightsList';
import { Panel } from './ui';
import type { UsageInsightsReport, UsageShareRow, LoopRow } from '../api/client';
import {
  formatPct,
  formatRelativeTime,
  formatTokensCompact,
  formatUsdOrDash,
  shortToolName,
} from '../lib/format';

// Minimal view of a session row needed to build the Tools table — just the
// per-tool call counts. Both History's richer `SessionRow` and Today's
// `SessionSummary` satisfy this structurally, so each view can pass its own
// session list type without a cross-view import.
interface ToolBreakdownSession {
  readonly toolBreakdown?: Record<string, number>;
}

export function aggregateToolUsage(
  rows: readonly ToolBreakdownSession[],
): Array<{ tool: string; count: number }> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.toolBreakdown) continue;
    for (const [tool, count] of Object.entries(r.toolBreakdown)) {
      totals.set(tool, (totals.get(tool) ?? 0) + count);
    }
  }
  return Array.from(totals.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

export interface ToolTableRow {
  readonly tool: string;
  readonly count: number;
  readonly sharePct: number;
}

/**
 * Builds `ShareTable` rows for the Tools breakdown: share of calls per
 * tool. No windowed per-tool cost figure exists in the session list
 * (`toolBreakdown` is call counts only), so share is of calls, not spend.
 */
export function buildToolTableRows(rows: readonly ToolBreakdownSession[]): ToolTableRow[] {
  const tools = aggregateToolUsage(rows);
  const total = tools.reduce((sum, t) => sum + t.count, 0);
  return tools.map((t) => ({
    tool: shortToolName(t.tool),
    count: t.count,
    sharePct: total > 0 ? (t.count / total) * 100 : 0,
  }));
}

// A row with real spend can carry a sharePct that's already floored to 0 by
// the backend — nudge it above 0 so formatPct renders "<1%" rather than
// "0%", which reads as no spend at all.
function formatSharePct(row: UsageShareRow): string {
  return formatPct(row.costUsd > 0 && row.sharePct === 0 ? 0.1 : row.sharePct);
}

export function UsageContributionPanel({
  data,
  isError,
  title,
  subtitle,
  toolRows,
}: {
  data: UsageInsightsReport | undefined;
  isError: boolean;
  title: string;
  subtitle: string;
  toolRows: readonly ToolTableRow[];
}): JSX.Element {
  if (isError) {
    return (
      <Panel title={title} subtitle={subtitle}>
        <EmptyState icon="radar" title="Usage insights unavailable" />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title={title} subtitle={subtitle}>
        <EmptyState variant="loading" title="Loading usage insights…" />
      </Panel>
    );
  }

  // Guards against a partial or malformed report (e.g. an unmocked test
  // endpoint, or a backend rollout gap) — every consumer below reads these
  // instead of `data.X` directly so a missing array degrades to an empty
  // table rather than throwing.
  const insights = data.insights ?? [];
  const skills = data.skills ?? [];
  const subagents = data.subagents ?? [];
  const plugins = data.plugins ?? [];
  const loops = data.loops ?? [];

  return (
    <Panel title={title} subtitle={subtitle}>
      <p className="text-xs text-ink-muted mb-3">
        Approximate, based on sessions recorded on this machine. These are independent
        characteristics of your spend, not a breakdown.
      </p>

      {data.sessionCount === 0 ? (
        <EmptyState icon="clock" title="No sessions in this window." />
      ) : (
        <UsageInsightsList insights={insights} />
      )}

      {data.sessionCount > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 text-xs mt-4">
          {skills.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Skills"
              rows={skills}
              rowKey={(row) => row.key}
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Skill', align: 'left', cell: (row) => row.key },
                {
                  header: 'Calls',
                  align: 'right',
                  cell: (row) => row.count,
                  sortValue: (row) => row.count,
                },
                {
                  header: 'Tokens',
                  align: 'right',
                  cell: (row) => formatTokensCompact(row.tokens),
                  sortValue: (row) => row.tokens,
                },
                {
                  header: '% of spend',
                  align: 'right',
                  cell: (row) => formatSharePct(row),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}

          {subagents.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Subagents"
              rows={subagents}
              rowKey={(row) => row.key}
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Type', align: 'left', cell: (row) => row.key },
                {
                  header: 'Requests',
                  align: 'right',
                  cell: (row) => row.count,
                  sortValue: (row) => row.count,
                },
                {
                  header: 'Tokens',
                  align: 'right',
                  cell: (row) => formatTokensCompact(row.tokens),
                  sortValue: (row) => row.tokens,
                },
                {
                  header: '% of spend',
                  align: 'right',
                  cell: (row) => formatSharePct(row),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}

          {plugins.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Plugins"
              rows={plugins}
              rowKey={(row) => row.key}
              defaultSort={{ column: 1, direction: 'desc' }}
              columns={[
                { header: 'Plugin', align: 'left', cell: (row) => row.key },
                {
                  header: '% of spend',
                  align: 'right',
                  cell: (row) => formatSharePct(row),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}

          {loops.length > 0 && (
            <ShareTable<LoopRow>
              title="Loops"
              className="md:col-span-2"
              rows={loops}
              rowKey={(row) => row.sessionId}
              defaultSort={{ column: 4, direction: 'desc' }}
              columns={[
                {
                  header: 'Session',
                  align: 'left',
                  className: 'truncate',
                  title: (row) => row.sessionName || row.sessionId,
                  cell: (row) => (
                    <Link
                      href={`/sessions?sessionIds=${encodeURIComponent(row.sessionId)}`}
                      className="text-accent-cyan hover:underline transition-colors duration-150"
                    >
                      {row.sessionName || row.sessionId.slice(0, 8)}
                    </Link>
                  ),
                },
                {
                  header: 'Runs',
                  align: 'right',
                  cell: (row) => row.runs,
                  sortValue: (row) => row.runs,
                },
                {
                  header: 'Tokens',
                  align: 'right',
                  cell: (row) => formatTokensCompact(row.tokens),
                  sortValue: (row) => row.tokens,
                },
                {
                  header: 'Per run',
                  align: 'right',
                  cell: (row) => formatTokensCompact(row.tokensPerRun),
                  sortValue: (row) => row.tokensPerRun,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.costUsd),
                  sortValue: (row) => row.costUsd,
                },
                {
                  header: 'Last run',
                  align: 'right',
                  className: 'text-ink-muted',
                  cell: (row) => formatRelativeTime(row.lastRunMs),
                  sortValue: (row) => row.lastRunMs,
                },
              ]}
            />
          )}

          {toolRows.length > 0 && (
            <ShareTable<ToolTableRow>
              title="Tools"
              rows={toolRows}
              rowKey={(row) => row.tool}
              defaultSort={{ column: 2, direction: 'desc' }}
              columns={[
                { header: 'Tool', align: 'left', cell: (row) => row.tool },
                {
                  header: 'Calls',
                  align: 'right',
                  cell: (row) => row.count,
                  sortValue: (row) => row.count,
                },
                {
                  header: 'Share of calls',
                  align: 'right',
                  cell: (row) => formatPct(row.sharePct),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}
        </div>
      )}

      {data.attributionRatePct !== null && data.attributionRatePct < 50 && (
        <p className="text-[10px] text-ink-muted italic mt-3">
          Skill and tool shares are based on {Math.round(data.attributionRatePct)}% of spend with
          attribution.
        </p>
      )}
    </Panel>
  );
}
