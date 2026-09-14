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
  formatUsd,
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
  /** Undefined when no windowed cost data was supplied at all, or when this specific tool has calls but isn't attributed yet. */
  readonly costUsd?: number;
  readonly tokens?: number;
}

export interface ModelShareRow {
  readonly model: string;
  readonly requestCount: number;
  readonly costPerMillionTokens: number | null;
  readonly totalCostUsd: number;
  readonly sharePct: number;
}

/**
 * Builds `ShareTable` rows for the Tools breakdown. With no `costByToolType`
 * (Today's call — no windowed per-tool cost figure exists in the session
 * list, `toolBreakdown` is call counts only), share is of calls. When
 * `costByToolType` is supplied (History's windowed `/api/cost-per-tool`
 * fetch) and carries any cost, share switches to share of cost — a tool with
 * calls but no attributed cost yet keeps `costUsd`/`tokens` undefined rather
 * than a fabricated 0.
 */
export function buildToolTableRows(
  rows: readonly ToolBreakdownSession[],
  costByToolType?: Record<string, { readonly totalCost: number; readonly tokens?: number }>,
): ToolTableRow[] {
  const tools = aggregateToolUsage(rows);
  const totalCalls = tools.reduce((sum, t) => sum + t.count, 0);
  const totalCost = costByToolType
    ? tools.reduce((sum, t) => sum + (costByToolType[t.tool]?.totalCost ?? 0), 0)
    : 0;
  return tools.map((t) => {
    const costEntry = costByToolType?.[t.tool];
    const sharePct =
      totalCost > 0
        ? ((costEntry?.totalCost ?? 0) / totalCost) * 100
        : totalCalls > 0
          ? (t.count / totalCalls) * 100
          : 0;
    return {
      tool: shortToolName(t.tool),
      count: t.count,
      sharePct,
      costUsd: costEntry?.totalCost,
      tokens: costEntry?.tokens,
    };
  });
}

// A row with real spend can carry a sharePct that's already floored to 0 by
// the backend — nudge it above 0 so formatPct renders "<1%" rather than
// "0%", which reads as no spend at all. costUsd is optional so this also
// covers ToolTableRow, whose per-tool cost can be genuinely unattributed.
function formatSharePct(row: { readonly costUsd?: number; readonly sharePct: number }): string {
  return formatPct(
    row.costUsd !== undefined && row.costUsd > 0 && row.sharePct === 0 ? 0.1 : row.sharePct,
  );
}

export function UsageContributionPanel({
  data,
  isError,
  title,
  subtitle,
  modelRows,
  toolRows,
  toolCostAvailable = false,
  toolCoverageCaveat = null,
}: {
  data: UsageInsightsReport | undefined;
  isError: boolean;
  title: string;
  subtitle: string;
  /** Adds a Models table as the first table in the grid. Omit (History's call site) to render no Models table at all. */
  modelRows?: readonly ModelShareRow[];
  toolRows: readonly ToolTableRow[];
  /** Whether toolRows carries real cost/token data (History's windowed fetch) — adds Cost/Tokens columns and switches the share column to cost-based. Today's calls-only toolRows omits this. */
  toolCostAvailable?: boolean;
  /** Set only when the Tools table's cost/token coverage is partial — e.g. "N of M sessions in this window have attribution data". Rendered as its own caveat line, mirroring History's dailySpendTruncated caveat. */
  toolCoverageCaveat?: string | null;
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
          {modelRows && modelRows.length > 0 && (
            <ShareTable<ModelShareRow>
              title="Models"
              rows={modelRows}
              rowKey={(row) => row.model}
              defaultSort={{ column: 4, direction: 'desc' }}
              columns={[
                {
                  header: 'Model',
                  align: 'left',
                  className: 'font-mono truncate max-w-[12rem]',
                  title: (row) => row.model,
                  cell: (row) => row.model,
                },
                {
                  header: 'Req',
                  align: 'right',
                  cell: (row) => row.requestCount,
                  sortValue: (row) => row.requestCount,
                },
                {
                  header: '$/1M tok',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.costPerMillionTokens),
                  sortValue: (row) => row.costPerMillionTokens ?? 0,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsd(row.totalCostUsd),
                  sortValue: (row) => row.totalCostUsd,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) => formatPct(row.sharePct),
                  sortValue: (row) => row.sharePct,
                },
              ]}
            />
          )}

          {skills.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Skills"
              rows={skills}
              rowKey={(row) => row.key}
              defaultSort={{ column: 4, direction: 'desc' }}
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
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.costUsd),
                  sortValue: (row) => row.costUsd,
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
              defaultSort={{ column: 4, direction: 'desc' }}
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
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.costUsd),
                  sortValue: (row) => row.costUsd,
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
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Plugin', align: 'left', cell: (row) => row.key },
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
              defaultSort={{ column: toolCostAvailable ? 4 : 2, direction: 'desc' }}
              columns={[
                { header: 'Tool', align: 'left', cell: (row) => row.tool },
                {
                  header: 'Calls',
                  align: 'right',
                  cell: (row) => row.count,
                  sortValue: (row) => row.count,
                },
                ...(toolCostAvailable
                  ? [
                      {
                        header: 'Cost',
                        align: 'right' as const,
                        cell: (row: ToolTableRow) => formatUsdOrDash(row.costUsd),
                        sortValue: (row: ToolTableRow) => row.costUsd ?? 0,
                      },
                      {
                        header: 'Tokens',
                        align: 'right' as const,
                        cell: (row: ToolTableRow) =>
                          row.tokens !== undefined ? formatTokensCompact(row.tokens) : '—',
                        sortValue: (row: ToolTableRow) => row.tokens ?? 0,
                      },
                    ]
                  : []),
                {
                  header: toolCostAvailable ? '% of spend' : 'Share of calls',
                  align: 'right',
                  cell: (row) =>
                    toolCostAvailable ? formatSharePct(row) : formatPct(row.sharePct),
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

      {toolCoverageCaveat && (
        <p className="text-[10px] text-ink-muted italic mt-3">{toolCoverageCaveat}</p>
      )}
    </Panel>
  );
}
