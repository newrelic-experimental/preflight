import { useState } from 'react';
import type { JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

import { EmptyState } from '../components/EmptyState';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import { DiscreteBlockChart, type DiscreteBlockChartItem } from '../components/DiscreteBlockChart';
import { Kpi } from '../components/Kpi';
import { RankedBars, type RankedBarRow } from '../components/RankedBars';
import { ShareTable } from '../components/ShareTable';
import { UsageInsightsList } from '../components/UsageInsightsList';
import { Card, Panel, Pill, Tabs, type PillTone } from '../components/ui';
import {
  fetchWeekly,
  fetchSessionsList,
  fetchCostPerOutcome,
  fetchPersonalCoach,
  fetchRecommendations,
  fetchClaudeMdImpact,
  fetchCollaborationProfile,
  fetchActivityHeatmap,
  fetchConcurrencyHistory,
  fetchInstructionDrift,
  fetchUsageInsights,
  qk,
  type WeeklyRow,
  type CostPerOutcomeResponse,
  type PersonalCoachResult,
  type PersonalWeekMetrics,
  type ConcurrencyHistoryResponse,
  type ActivityHeatmapHistoryResponse,
  type InstructionDriftResponse,
  type DriftCorrelationEntry,
  type RecommendationsApiResponse,
  type ClaudeMdImpactApiResponse,
  type CollaborationProfileApiResponse,
  type MetricDelta,
  type UsageInsightsReport,
  type UsageShareRow,
  type LoopRow,
} from '../api/client';
import {
  formatAxisDate,
  formatAxisUsd,
  formatAxisWeek,
  formatPct,
  formatRelativeTime,
  formatTokensCompact,
  formatUsd,
  formatUsdOrDash,
  shortToolName,
} from '../lib/format';

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string | number;
  readonly estimatedCostUsd?: number | null;
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
  readonly efficiencyScore?: number | null;
  readonly toolCallCount?: number;
  readonly toolBreakdown?: Record<string, number>;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly tokensCacheRead?: number;
  readonly tokensCacheCreation?: number;
  readonly tokensThinking?: number;
  readonly antiPatterns?: ReadonlyArray<{ readonly type: string }>;
}

type HistoryWindow = '7' | '30' | '90';

const TICK_STYLE = { fill: 'var(--color-ink-muted)', fontSize: 10 };
const GRID_STROKE = 'var(--color-border-subtle)';
const TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-medium)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-ink-base)',
};
const ACCENT = 'var(--color-accent-green)';
const ACCENT_AMBER = 'var(--color-accent-amber)';

function windowSubtitle(days: number): string {
  return `Last ${days} days`;
}

const INSTRUCTION_FILE_TOOLTIP =
  "Compares session outcomes before and after your most recent edit to an instruction file (CLAUDE.md, or the active platform's equivalent) — efficiency, cost, and correction rate. The pill shows whether the most recent edit measured as an improvement.";

const DRIFT_VERDICT_TONE: Record<DriftCorrelationEntry['verdict'], PillTone> = {
  improved: 'success',
  degraded: 'danger',
  neutral: 'neutral',
  insufficient_data: 'neutral',
};

function verdictColor(verdict: string): string {
  if (verdict.startsWith('Positive')) return 'text-accent-green';
  if (verdict.startsWith('Negative')) return 'text-accent-red';
  return 'text-accent-amber';
}

function ptsDeltaText(delta: MetricDelta | null | undefined): string {
  if (!delta) return '—';
  if (delta.value === 0) return '0pts';
  const pts = Math.round(Math.abs(delta.value) * 100);
  return `${delta.value > 0 ? '↑' : '↓'}${pts}pts`;
}

function pctDeltaText(delta: MetricDelta | undefined): string {
  if (!delta) return '—';
  if (delta.percentChange == null) return '—';
  if (delta.value === 0) return '0%';
  const pct = Math.round(Math.abs(delta.percentChange));
  return `${delta.value > 0 ? '↑' : '↓'}${pct}%`;
}

function InstructionFilePanel({
  impact,
  impactError,
  drift,
}: {
  impact: ClaudeMdImpactApiResponse | undefined;
  impactError: boolean;
  drift: InstructionDriftResponse | undefined;
}): JSX.Element {
  if (impactError) {
    return (
      <Panel title="Instruction file" tooltip={INSTRUCTION_FILE_TOOLTIP}>
        <EmptyState icon="radar" title="Instruction file impact unavailable" />
      </Panel>
    );
  }
  if (!impact) {
    return (
      <Panel title="Instruction file" tooltip={INSTRUCTION_FILE_TOOLTIP}>
        <EmptyState variant="loading" title="Loading instruction file impact…" />
      </Panel>
    );
  }

  const driftLatest = drift?.recentCorrelations[drift.recentCorrelations.length - 1];
  const pill = driftLatest ? (
    <Pill tone={DRIFT_VERDICT_TONE[driftLatest.verdict]}>{driftLatest.verdict}</Pill>
  ) : undefined;

  if (
    impact.message ||
    !impact.change ||
    !impact.before ||
    !impact.after ||
    !impact.deltas ||
    !impact.verdict
  ) {
    if (!driftLatest) {
      return (
        <Panel title="Instruction file" tooltip={INSTRUCTION_FILE_TOOLTIP}>
          <EmptyState variant="inline" title="No instruction file changes tracked yet." />
        </Panel>
      );
    }
    return (
      <Panel title="Instruction file" tooltip={INSTRUCTION_FILE_TOOLTIP} action={pill}>
        <EmptyState variant="inline" title="No instruction file impact tracked yet." />
      </Panel>
    );
  }

  const changeDate = new Date(impact.change.timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const beforeEff =
    impact.before.avgEfficiencyScore !== null
      ? Math.round(impact.before.avgEfficiencyScore * 100)
      : null;
  const afterEff =
    impact.after.avgEfficiencyScore !== null
      ? Math.round(impact.after.avgEfficiencyScore * 100)
      : null;

  return (
    <Panel title="Instruction file" tooltip={INSTRUCTION_FILE_TOOLTIP} action={pill}>
      <div className="text-xs mb-3">
        <span className={`font-medium ${verdictColor(impact.verdict)}`}>{impact.verdict}</span>
        <span className="text-[10px] text-ink-muted">
          {' · '}
          {impact.change.changeType} {impact.change.filePath.split('/').pop()} · {changeDate}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <span className="text-ink-muted" />
        {/* Sample size next to each column — a 1-vs-1 session comparison
            shouldn't read with the same confidence as a 50-vs-50 one. */}
        <span className="text-ink-muted">Before (n={impact.before.sessionCount})</span>
        <span className="text-ink-muted">After (n={impact.after.sessionCount})</span>
        <span className="text-ink-muted">Δ</span>

        <span className="text-ink-muted">Efficiency</span>
        <span className="font-mono">{beforeEff ?? '—'}</span>
        <span className="font-mono">{afterEff ?? '—'}</span>
        <span
          className={
            impact.deltas.efficiencyScore == null
              ? 'text-ink-muted'
              : impact.deltas.efficiencyScore.improved
                ? 'text-accent-green'
                : 'text-accent-amber'
          }
        >
          {ptsDeltaText(impact.deltas.efficiencyScore)}
        </span>

        <span className="text-ink-muted">Cost/session</span>
        <span className="font-mono">{formatUsd(impact.before.avgCostUsd)}</span>
        <span className="font-mono">{formatUsd(impact.after.avgCostUsd)}</span>
        <span className={impact.deltas.cost.improved ? 'text-accent-green' : 'text-accent-amber'}>
          {pctDeltaText(impact.deltas.cost)}
        </span>

        <span className="text-ink-muted">Correction rate</span>
        <span className="font-mono">{formatPct(impact.before.avgCorrectionRate * 100)}</span>
        <span className="font-mono">{formatPct(impact.after.avgCorrectionRate * 100)}</span>
        <span
          className={
            impact.deltas.correctionRate.improved ? 'text-accent-green' : 'text-accent-amber'
          }
        >
          {pctDeltaText(impact.deltas.correctionRate)}
        </span>
      </div>
      {impact.contextTokensForClaudeMd != null && impact.contextTokensForClaudeMd > 0 && (
        <div className="text-[10px] text-ink-muted italic mt-2">
          Instruction file adds ~{impact.contextTokensForClaudeMd.toLocaleString()} tokens/turn
        </div>
      )}
    </Panel>
  );
}

export function History(): JSX.Element {
  const [windowDays, setWindowDays] = useState<HistoryWindow>('30');
  const windowNum = Number(windowDays) as 7 | 30 | 90;

  const weekly = useQuery<WeeklyRow[]>({
    queryKey: qk.weekly,
    queryFn: fetchWeekly,
  });

  const sessions = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200),
  });

  const costPerOutcome = useQuery<CostPerOutcomeResponse>({
    queryKey: qk.costPerOutcome(windowNum),
    queryFn: () => fetchCostPerOutcome(windowNum),
  });

  const coach = useQuery<PersonalCoachResult>({
    queryKey: qk.personalCoach,
    queryFn: fetchPersonalCoach,
  });

  const recommendations = useQuery<RecommendationsApiResponse>({
    queryKey: qk.recommendations,
    queryFn: fetchRecommendations,
    retry: false,
  });

  const claudeMdImpact = useQuery<ClaudeMdImpactApiResponse>({
    queryKey: qk.claudeMdImpact,
    queryFn: fetchClaudeMdImpact,
    retry: false,
  });

  const collabProfile = useQuery<CollaborationProfileApiResponse>({
    queryKey: qk.collaborationProfile,
    queryFn: fetchCollaborationProfile,
    retry: false,
  });

  const activityGrid = useQuery<ActivityHeatmapHistoryResponse>({
    queryKey: qk.activityHeatmap('history'),
    queryFn: () => fetchActivityHeatmap('history', 12),
  });

  const concurrencyHistory = useQuery<ConcurrencyHistoryResponse>({
    queryKey: qk.concurrencyHistory(windowNum),
    queryFn: () => fetchConcurrencyHistory(windowNum),
  });

  const drift = useQuery<InstructionDriftResponse>({
    queryKey: qk.instructionDrift,
    queryFn: fetchInstructionDrift,
  });

  const usageInsights = useQuery<UsageInsightsReport>({
    queryKey: qk.usageInsights(windowNum),
    queryFn: () => fetchUsageInsights(windowNum),
  });

  const hasLoadError =
    weekly.isError || sessions.isError || costPerOutcome.isError || concurrencyHistory.isError;

  // API returns newest-first; reverse for chronological left-to-right chart rendering
  const weeklyChronological = [...(weekly.data ?? [])].reverse();
  const weeklyData = weeklyChronological.map((w) => {
    const score = w.avgEfficiencyScore;
    return { week: w.week || '?', efficiency: score !== null ? Math.round(score * 100) : null };
  });

  const rawSessions = sessions.data ?? [];
  const windowSessions = filterSessionsToWindow(rawSessions, windowNum);
  const dailyData = padDailyCostWindow(aggregateDailyCost(rawSessions, windowNum), windowNum);
  // The 200-session sample can run out before it reaches back the full
  // window (a busy account can churn through 200 sessions in far fewer
  // days than the window covers). When it does, the padded $0 days at the
  // start of the window aren't confirmed zero-spend — they're simply
  // outside the sample's reach. Flag that instead of presenting them as
  // real zeros. Only flag it when the sample actually hit the 200-row cap;
  // an account with fewer than 200 total sessions has nothing withheld.
  const dailySpendTruncated =
    rawSessions.length >= 200 && isDailySpendSampleTruncated(rawSessions, windowNum);
  const sampleSpanForWindow = dailySpendTruncated ? sampleSpanDays(rawSessions) : null;
  const outcomeRows = buildOutcomeData(costPerOutcome.data);
  const outcomeTotalCost =
    costPerOutcome.data?.totalCost ?? outcomeRows.reduce((sum, r) => sum + r.totalCost, 0);
  const antiPatternSeries = buildAntiPatternSeries(weeklyChronological);
  const modelPerf = aggregateModelPerformance(windowSessions);
  const modelPerfTotalCost = modelPerf.reduce((sum, m) => sum + (m.avgCost ?? 0) * m.sessions, 0);
  const toolTableRows = buildToolTableRows(windowSessions);
  const kpis = computeHistoryKpis(windowSessions);

  return (
    <section>
      <GeoBanner theme="history" />
      <div className="flex items-center justify-between gap-2 mb-4">
        <h1 className="text-xl font-semibold gradient-text">History</h1>
        <Tabs<HistoryWindow>
          value={windowDays}
          onChange={setWindowDays}
          options={[
            { value: '7', label: '7d' },
            { value: '30', label: '30d' },
            { value: '90', label: '90d' },
          ]}
          ariaLabel="History window"
        />
      </div>

      {hasLoadError && (
        <div className="text-accent-red text-xs mb-3">
          Error loading some history data. Charts below may be incomplete.
        </div>
      )}

      <Card padding="lg" tone="elevated" glow="green" className="mb-4">
        <div className="grid grid-cols-5 gap-4">
          <Kpi
            label="spend"
            value={formatUsd(kpis.spendUsd)}
            animate
            numericValue={kpis.spendUsd}
            format={formatUsd}
          />
          <Kpi
            label="sessions"
            value={String(kpis.sessionCount)}
            animate
            numericValue={kpis.sessionCount}
          />
          <Kpi
            label="avg efficiency"
            value={kpis.avgEfficiency !== null ? formatPct(kpis.avgEfficiency * 100) : '—'}
            {...(kpis.avgEfficiency !== null
              ? { animate: true, numericValue: Math.round(kpis.avgEfficiency * 100), suffix: '%' }
              : {})}
          />
          <Kpi label="avg cost / session" value={formatUsdOrDash(kpis.avgCostPerSession)} />
          <Kpi
            label="flags"
            tone={kpis.flags > 0 ? 'warn' : 'neutral'}
            value={String(kpis.flags)}
            animate
            numericValue={kpis.flags}
          />
        </div>
        <div className="text-[10px] text-ink-muted mt-3">
          {kpis.sessionCount} sessions
          {sampleSpanForWindow !== null && ` · oldest ${sampleSpanForWindow} days shown`}
        </div>
      </Card>

      <Panel title="Daily spend" subtitle={windowSubtitle(windowNum)} className="mb-3">
        <div className="h-44 min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <BarChart data={dailyData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.9} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0.4} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
              <XAxis
                dataKey="day"
                tick={TICK_STYLE}
                stroke={GRID_STROKE}
                tickFormatter={formatAxisDate}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} tickFormatter={formatAxisUsd} />
              {/* cursor={false}: with the window padded, most bars are zero.
                  Recharts' default cursor draws a full-height rectangle over
                  the hovered slot, which reads as a phantom bar on empty
                  days. The tooltip already labels the date. */}
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(label) => formatAxisDate(String(label))}
                formatter={(value) => formatUsd(Number(value))}
                cursor={false}
              />
              <Bar dataKey="cost" fill="url(#costGradient)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {dailySpendTruncated && (
          <div className="text-[10px] text-ink-muted italic mt-1">
            Sample doesn&apos;t reach back {windowNum} days — early days in this chart may
            undercount actual spend.
          </div>
        )}
      </Panel>

      <div className="mt-3">
        <UsageContributionPanel
          data={usageInsights.data}
          isError={usageInsights.isError}
          windowDays={windowNum}
          toolRows={toolTableRows}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <Panel
          title="Model performance"
          subtitle={windowSubtitle(windowNum)}
          footnote={
            modelPerf.some((m) => m.flagged)
              ? '▲ Highlighted models had sessions with elevated error rates'
              : undefined
          }
        >
          {modelPerf.length === 0 ? (
            <EmptyState
              icon="radar"
              title="No model data yet"
              subtitle="Complete a few sessions to see model performance."
            />
          ) : (
            <ShareTable<ModelPerformanceRow>
              title="Model performance"
              hideTitle
              rows={modelPerf}
              rowKey={(row) => row.model}
              defaultSort={{ column: 5, direction: 'desc' }}
              columns={[
                {
                  header: 'Model',
                  align: 'left',
                  className: 'font-medium',
                  cell: (row) => row.model,
                },
                {
                  header: 'Sessions',
                  align: 'right',
                  cell: (row) => row.sessions,
                  sortValue: (row) => row.sessions,
                },
                {
                  header: 'Eff.',
                  align: 'right',
                  cell: (row) =>
                    row.avgEfficiency !== null
                      ? formatPct(Math.min(100, row.avgEfficiency * 100))
                      : '—',
                  sortValue: (row) => row.avgEfficiency ?? -1,
                },
                {
                  header: 'Success',
                  align: 'right',
                  className: (row) => (row.flagged ? 'text-accent-amber' : undefined),
                  cell: (row) => (
                    <>
                      {row.flagged && '▲ '}
                      {row.avgSuccessRate !== null
                        ? formatPct(Math.min(100, row.avgSuccessRate * 100))
                        : '—'}
                    </>
                  ),
                  sortValue: (row) => row.avgSuccessRate ?? -1,
                },
                {
                  header: 'Avg $',
                  align: 'right',
                  cell: (row) => formatUsdOrDash(row.avgCost),
                  sortValue: (row) => row.avgCost ?? -1,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) => {
                    const share = modelSharePct(row, modelPerfTotalCost);
                    return share !== null ? formatPct(share) : '—';
                  },
                  sortValue: (row) => modelSharePct(row, modelPerfTotalCost) ?? -1,
                },
                {
                  header: '$/1M tok',
                  align: 'right',
                  className: 'text-ink-subtle',
                  cell: (row) => formatUsdOrDash(row.costPerMillionTokens),
                  sortValue: (row) => row.costPerMillionTokens ?? -1,
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="Cost per outcome" subtitle={windowSubtitle(windowNum)}>
          {outcomeRows.length === 0 ? (
            <EmptyState icon="radar" title="No outcomes yet" />
          ) : (
            <ShareTable<(typeof outcomeRows)[number]>
              title="Outcomes"
              hideTitle
              rows={outcomeRows}
              rowKey={(row) => row.outcome}
              defaultSort={{ column: 3, direction: 'desc' }}
              columns={[
                { header: 'Outcome', align: 'left', cell: (row) => row.outcome },
                {
                  header: 'Sessions',
                  align: 'right',
                  cell: (row) => row.count,
                  sortValue: (row) => row.count,
                },
                {
                  header: 'Cost',
                  align: 'right',
                  cell: (row) => formatUsd(row.totalCost),
                  sortValue: (row) => row.totalCost,
                },
                {
                  header: 'Share',
                  align: 'right',
                  cell: (row) =>
                    formatPct(outcomeTotalCost > 0 ? (row.totalCost / outcomeTotalCost) * 100 : 0),
                  sortValue: (row) =>
                    outcomeTotalCost > 0 ? (row.totalCost / outcomeTotalCost) * 100 : 0,
                },
              ]}
            />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-3">
        <Panel title="Weekly efficiency" subtitle="Last 12 weeks">
          <div className="h-44 min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
              <AreaChart data={weeklyData}>
                <defs>
                  <linearGradient id="effGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis
                  dataKey="week"
                  tick={TICK_STYLE}
                  stroke={GRID_STROKE}
                  tickFormatter={formatAxisWeek}
                />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Area
                  type="monotone"
                  dataKey="efficiency"
                  stroke={ACCENT}
                  strokeWidth={2}
                  fill="url(#effGradient)"
                  dot={{ r: 2, fill: ACCENT }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Anti-pattern frequency" subtitle="Last 12 weeks">
          {antiPatternSeries.length === 0 || antiPatternSeries.every((d) => d.count === 0) ? (
            <EmptyState
              icon="checkmark"
              title="No anti-patterns detected"
              subtitle="No anti-patterns detected in the loaded weeks."
            />
          ) : (
            <div className="h-44 min-w-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart data={antiPatternSeries}>
                  <defs>
                    <linearGradient id="antiPatternGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ACCENT_AMBER} stopOpacity={0.9} />
                      <stop offset="100%" stopColor={ACCENT_AMBER} stopOpacity={0.4} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="week"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    tickFormatter={formatAxisWeek}
                  />
                  <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" fill="url(#antiPatternGradient)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <ActivityPanel data={activityGrid.data} />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <CoachCard data={coach.data} />
        <RecommendationsPanel data={recommendations.data} isError={recommendations.isError} />
      </div>

      <div className="mt-3">
        <InstructionFilePanel
          impact={claudeMdImpact.data}
          impactError={claudeMdImpact.isError}
          drift={drift.data}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <CollaborationProfilePanel data={collabProfile.data} isError={collabProfile.isError} />
        <ConcurrencyPanel data={concurrencyHistory.data} windowNum={windowNum} />
      </div>
    </section>
  );
}

// A row with real spend can carry a sharePct that's already floored to 0 by
// the backend — nudge it above 0 so formatPct renders "<1%" rather than
// "0%", which reads as no spend at all.
function formatSharePct(row: UsageShareRow): string {
  return formatPct(row.costUsd > 0 && row.sharePct === 0 ? 0.1 : row.sharePct);
}

function UsageContributionPanel({
  data,
  isError,
  windowDays,
  toolRows,
}: {
  data: UsageInsightsReport | undefined;
  isError: boolean;
  windowDays: 7 | 30 | 90;
  toolRows: readonly ToolTableRow[];
}): JSX.Element {
  if (isError) {
    return (
      <Panel title="What's contributing to your spend" subtitle={windowSubtitle(windowDays)}>
        <EmptyState icon="radar" title="Usage insights unavailable" />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="What's contributing to your spend" subtitle={windowSubtitle(windowDays)}>
        <EmptyState variant="loading" title="Loading usage insights…" />
      </Panel>
    );
  }

  return (
    <Panel title="What's contributing to your spend" subtitle={windowSubtitle(windowDays)}>
      <p className="text-xs text-ink-muted mb-3">
        Approximate, based on sessions recorded on this machine. These are independent
        characteristics of your spend, not a breakdown.
      </p>

      {data.sessionCount === 0 ? (
        <EmptyState icon="clock" title="No sessions in this window." />
      ) : (
        <UsageInsightsList insights={data.insights} />
      )}

      {data.sessionCount > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 text-xs mt-4">
          {data.skills.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Skills"
              rows={data.skills}
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

          {data.subagents.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Subagents"
              rows={data.subagents}
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

          {data.plugins.length > 0 && (
            <ShareTable<UsageShareRow>
              title="Plugins"
              rows={data.plugins}
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

          {data.loops.length > 0 && (
            <ShareTable<LoopRow>
              title="Loops"
              className="md:col-span-2"
              rows={data.loops}
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

function CoachMetricsTable({
  thisWeek,
  baseline,
}: {
  thisWeek: PersonalWeekMetrics;
  baseline: PersonalWeekMetrics;
}): JSX.Element {
  const effDelta =
    thisWeek.avgEfficiencyScore !== null && baseline.avgEfficiencyScore !== null
      ? Math.round((thisWeek.avgEfficiencyScore - baseline.avgEfficiencyScore) * 100)
      : null;

  const costDelta =
    baseline.avgCostPerSession > 0
      ? (thisWeek.avgCostPerSession - baseline.avgCostPerSession) / baseline.avgCostPerSession
      : null;

  const apDelta =
    baseline.antiPatternRate > 0
      ? (thisWeek.antiPatternRate - baseline.antiPatternRate) / baseline.antiPatternRate
      : null;

  const sessionsDelta = Math.round(thisWeek.sessionsCount - baseline.sessionsCount);

  function effColor(delta: number | null): string {
    if (delta === null) return 'text-ink-muted';
    if (delta >= 5) return 'text-accent-green';
    if (delta <= -5) return 'text-accent-amber';
    return 'text-ink-muted';
  }

  function costColor(delta: number | null): string {
    if (delta === null) return 'text-ink-muted';
    if (delta <= -0.15) return 'text-accent-green';
    if (delta >= 0.25) return 'text-accent-amber';
    return 'text-ink-muted';
  }

  function apColor(delta: number | null): string {
    if (delta === null) return 'text-ink-muted';
    if (delta <= -0.2) return 'text-accent-green';
    if (delta >= 0.25) return 'text-accent-amber';
    return 'text-ink-muted';
  }

  function effDeltaText(delta: number | null): string {
    if (delta === null) return '—';
    if (delta === 0) return '0pts';
    return `${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}pts`;
  }

  function pctDeltaTextLocal(delta: number | null): string {
    if (delta === null) return '—';
    if (delta === 0) return '0%';
    return `${delta > 0 ? '↑' : '↓'}${Math.abs(Math.round(delta * 100))}%`;
  }

  function sessionsDeltaText(delta: number): string {
    if (delta === 0) return '0';
    return delta > 0 ? `+${delta}` : `${delta}`;
  }

  const effValue =
    thisWeek.avgEfficiencyScore !== null
      ? Math.round(thisWeek.avgEfficiencyScore * 100).toString()
      : '—';

  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs mb-3">
      <span className="text-ink-muted" />
      <span className="text-ink-muted">This wk</span>
      <span className="text-ink-muted">vs baseline</span>

      <span className="text-ink-muted">Efficiency</span>
      <span className="font-mono">{effValue}</span>
      <span className={effColor(effDelta)}>{effDeltaText(effDelta)}</span>

      <span className="text-ink-muted">Cost / session</span>
      <span className="font-mono">{formatUsd(thisWeek.avgCostPerSession)}</span>
      <span className={costColor(costDelta)}>{pctDeltaTextLocal(costDelta)}</span>

      <span className="text-ink-muted">Anti-pattern rate</span>
      <span className="font-mono">{formatPct(thisWeek.antiPatternRate * 100)}</span>
      <span className={apColor(apDelta)}>{pctDeltaTextLocal(apDelta)}</span>

      <span className="text-ink-muted">Sessions</span>
      <span className="font-mono">{Math.round(thisWeek.sessionsCount)}</span>
      <span className="text-ink-muted">{sessionsDeltaText(sessionsDelta)}</span>
    </div>
  );
}

function categoryBorderColor(category: string): string {
  if (category === 'cost_optimization') return 'var(--color-accent-amber)';
  if (category === 'efficiency') return 'var(--color-accent-red)';
  if (category === 'prompt_engineering') return 'var(--color-accent-blue)';
  if (category === 'claudemd') return 'var(--color-accent-purple)';
  if (category === 'model_selection') return 'var(--color-accent-teal)';
  return 'var(--color-ink-muted)';
}

function priorityDotColor(priority: 'high' | 'medium' | 'low'): string {
  if (priority === 'high') return 'var(--color-accent-amber)';
  if (priority === 'medium') return 'var(--color-accent-blue)';
  return 'var(--color-ink-muted)';
}

function RecommendationsPanel({
  data,
  isError,
}: {
  data: RecommendationsApiResponse | undefined;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <Panel title="Recommendations">
        <EmptyState
          icon="radar"
          title="Recommendations unavailable"
          subtitle="Connect a full Preflight session to enable recommendations."
        />
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel title="Recommendations">
        <EmptyState variant="loading" title="Loading recommendations…" />
      </Panel>
    );
  }

  if (data.recommendations.length === 0) {
    return (
      <Panel title="Recommendations">
        <EmptyState
          variant="inline"
          title="No recommendations yet"
          subtitle="Recommendations appear after a few sessions of data."
        />
      </Panel>
    );
  }

  const highItems = data.recommendations.filter((r) => r.priority === 'high');
  const otherItems = data.recommendations.filter((r) => r.priority !== 'high');

  return (
    <Panel title="Recommendations">
      <div className="space-y-3">
        {highItems.map((rec) => (
          <div
            key={rec.id}
            className="border-l-2 pl-3"
            style={{ borderColor: categoryBorderColor(rec.category) }}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-ink-base">{rec.title}</span>
              {rec.estimatedSavings && (
                <span className="text-[10px] text-accent-green shrink-0">
                  {rec.estimatedSavings}
                </span>
              )}
            </div>
            <div className="text-xs text-ink-muted mt-0.5">{rec.detail}</div>
            <div className="text-[10px] text-ink-muted italic mt-0.5">{rec.evidence}</div>
          </div>
        ))}
        {otherItems.length > 0 && (
          <div className={highItems.length > 0 ? 'border-t border-border-subtle pt-3' : ''}>
            <div className="space-y-2">
              {otherItems.map((rec) => (
                <div key={rec.id} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: priorityDotColor(rec.priority) }}
                    />
                    <span className="text-xs text-ink-base">{rec.title}</span>
                  </div>
                  <div className="text-[10px] text-ink-muted mt-0.5 pl-3.5">{rec.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function CollaborationProfilePanel({
  data,
  isError,
}: {
  data: CollaborationProfileApiResponse | undefined;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <Panel title="Collaboration profile">
        <EmptyState icon="radar" title="Collaboration profile unavailable" />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="Collaboration profile">
        <EmptyState variant="loading" title="Loading collaboration profile…" />
      </Panel>
    );
  }
  if (data.sessionCount === 0) {
    return (
      <Panel title="Collaboration profile">
        <EmptyState
          icon="radar"
          title="No collaboration data yet"
          subtitle="Profile appears after a few sessions."
        />
      </Panel>
    );
  }
  const dims = [
    {
      name: 'Specificity',
      key: 'specificity',
      value: Math.round(data.dimensions.specificity * 100),
      delta: data.teamDeltas.specificity,
      lowerIsBetter: false,
      note: '',
    },
    {
      name: 'Autonomy',
      key: 'autonomy',
      value: Math.round(data.dimensions.autonomy * 100),
      delta: data.teamDeltas.autonomy,
      lowerIsBetter: false,
      note: '',
    },
    {
      // The backend dimension is a correction-free score — higher means
      // fewer corrections were needed — so the label spells that out
      // directly instead of reading as a raw "rate of corrections" (which
      // would suggest the opposite direction).
      name: 'Correction-free rate',
      key: 'correctionRate',
      value: Math.round(data.dimensions.correctionRate * 100),
      delta: data.teamDeltas.correctionRate,
      lowerIsBetter: false,
      note: ' (higher = better)',
    },
    {
      name: 'Task complexity',
      key: 'taskComplexity',
      value: Math.round(data.dimensions.taskComplexity * 100),
      delta: data.teamDeltas.taskComplexity,
      lowerIsBetter: false,
      note: '',
    },
  ];

  const bars: RankedBarRow[] = dims.map((d) => ({
    key: d.key,
    label: d.name,
    value: formatPct(d.value),
    share: d.value,
  }));

  return (
    <Panel
      title="Collaboration profile"
      subtitle={data.developerCount <= 1 ? 'No team data yet' : undefined}
    >
      <div className="text-xs mb-3">
        <span className="text-sm font-medium text-ink-base">{data.classification}</span>
        <span className="text-ink-muted"> · {data.sessionCount} sessions</span>
      </div>
      <RankedBars rows={bars} max={4} />
      {/* The "vs team" deltas below are computed against a baseline of
          whatever developers have recorded sessions. With developerCount <= 1
          that baseline is just this developer, so every delta is trivially
          ~0 and reads as "right on target" rather than "no comparison data
          exists yet" — so they're hidden entirely rather than shown as
          misleading zeros. */}
      {data.developerCount > 1 && (
        <div className="space-y-1 mt-2">
          {dims.map((d) => {
            const pct = Math.round(Math.abs(d.delta) * 100);
            const positive = d.lowerIsBetter ? d.delta < 0 : d.delta > 0;
            const color =
              d.delta === 0
                ? 'text-ink-muted'
                : positive
                  ? 'text-accent-green'
                  : 'text-accent-amber';
            const sign = d.delta > 0 ? '+' : d.delta < 0 ? '-' : '';
            const note = d.lowerIsBetter ? ' (lower = better)' : d.note;
            return (
              <div key={d.key} className="flex items-center justify-between text-[10px]">
                <span className="text-ink-muted">
                  {d.name}
                  {note}
                </span>
                <span className={color}>
                  {sign}
                  {pct}% vs team
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function CoachCard({ data }: { data: PersonalCoachResult | undefined }): JSX.Element {
  if (!data) {
    return (
      <Panel title="Personal coach">
        <EmptyState variant="loading" title="Loading coaching insights…" />
      </Panel>
    );
  }
  if (data.status === 'insufficient_data') {
    return (
      <Panel title="Personal coach">
        <div className="text-ink-muted text-xs">{data.message}</div>
      </Panel>
    );
  }
  return (
    <Panel title="Personal coach">
      <div className="text-xs space-y-2">
        <CoachMetricsTable thisWeek={data.thisWeek} baseline={data.baseline} />
        <div>
          <span className="text-accent-cyan font-semibold">Top recommendation: </span>
          {data.topRecommendation}
        </div>
        {data.highlights.length > 0 && (
          <ul className="list-disc list-inside text-accent-green">
            {data.highlights.map((h) => (
              <li key={`hl-${h}`}>{h}</li>
            ))}
          </ul>
        )}
        {data.regressions.length > 0 && (
          <ul className="list-disc list-inside text-accent-amber">
            {data.regressions.map((r) => (
              <li key={`rg-${r}`}>{r}</li>
            ))}
          </ul>
        )}
        {data.streaks.length > 0 && (
          <ul className="list-disc list-inside text-ink-muted">
            {data.streaks.map((s) => (
              <li key={`st-${s}`}>{s}</li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function ActivityPanel({
  data,
}: {
  data: ActivityHeatmapHistoryResponse | undefined;
}): JSX.Element {
  return (
    <Panel title="Activity heatmap" subtitle="Last 12 weeks">
      {!data ? (
        <EmptyState variant="loading" title="Loading activity…" />
      ) : data.days.length === 0 ? (
        <EmptyState variant="inline" title="No activity yet" />
      ) : (
        <ActivityHeatmap
          variant="grid"
          buckets={[]}
          maxCount={data.maxCount}
          days={data.days}
          ariaLabel="Daily activity heatmap for the last 12 weeks"
        />
      )}
    </Panel>
  );
}

function ConcurrencyPanel({
  data,
  windowNum,
}: {
  data: ConcurrencyHistoryResponse | undefined;
  windowNum: number;
}): JSX.Element {
  const concurrencyData = data?.dailyPeaks ?? [];
  const hasConcurrencyData = concurrencyData.some((d) => d.peak > 0);
  return (
    <Panel title="Peak concurrent sessions" subtitle={windowSubtitle(windowNum)}>
      {!data ? (
        <EmptyState variant="loading" title="Loading concurrency…" />
      ) : hasConcurrencyData ? (
        <div className="flex flex-col items-center gap-2">
          <div className="text-2xl font-bold tabular-nums gradient-text">
            {Math.max(...concurrencyData.map((d) => d.peak))}
          </div>
          <ConcurrencyBlockChart data={concurrencyData} />
        </div>
      ) : (
        <EmptyState
          icon="code"
          title="No concurrent sessions yet"
          subtitle="Run two or more Claude Code sessions at the same time to populate this chart."
        />
      )}
    </Panel>
  );
}

export function aggregateDailyCost(
  rows: SessionRow[],
  days: number,
): Array<{ day: string; cost: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.estimatedCostUsd == null || r.startTime == null) continue;
    const d = new Date(r.startTime);
    // Use local-time getters so a session at 10pm UTC-5 lands on its
    // local day, not the UTC day after.
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(day, (byDay.get(day) ?? 0) + r.estimatedCostUsd);
  }
  const sorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.slice(-days).map(([day, cost]) => ({ day, cost: Number(cost.toFixed(2)) }));
}

/**
 * True when the session sample (already capped upstream, e.g. to the most
 * recent 200) doesn't reach back the full `days`-day window — i.e. the
 * oldest session in `rows` is more recent than the window's start date.
 * When true, `padDailyCostWindow`'s zero-filled early days aren't confirmed
 * zero-spend; they're simply outside what the sample covers, and the UI
 * should flag that instead of presenting them as real zeros. Callers should
 * also confirm the sample actually hit its row cap before using this — a
 * short window can be genuinely complete rather than truncated.
 */
export function isDailySpendSampleTruncated(
  rows: SessionRow[],
  days: number,
  today: Date = new Date(),
): boolean {
  if (rows.length === 0) return false;
  let oldest: number | null = null;
  for (const r of rows) {
    if (r.startTime == null) continue;
    const t = new Date(r.startTime).getTime();
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (oldest === null) return false;
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - (days - 1));
  windowStart.setHours(0, 0, 0, 0);
  return oldest > windowStart.getTime();
}

/**
 * Number of calendar days between the oldest session in `rows` and `today`,
 * inclusive. Used to tell the reader how far back a capped sample actually
 * reaches when it doesn't cover the full requested window (see
 * `isDailySpendSampleTruncated`). Returns `0` when `rows` has no dated
 * sessions.
 */
export function sampleSpanDays(rows: SessionRow[], today: Date = new Date()): number {
  let oldest: number | null = null;
  for (const r of rows) {
    if (r.startTime == null) continue;
    const t = new Date(r.startTime).getTime();
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (oldest === null) return 0;
  const diffMs = today.getTime() - oldest;
  return Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
}

/**
 * Filters a session list down to the ones that started within the last
 * `days` calendar days ending today (local time), inclusive. Used to derive
 * a window-scoped subset from the shared 200-session fetch instead of
 * issuing a second request.
 */
export function filterSessionsToWindow(
  rows: SessionRow[],
  days: number,
  today: Date = new Date(),
): SessionRow[] {
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - (days - 1));
  windowStart.setHours(0, 0, 0, 0);
  const startMs = windowStart.getTime();
  return rows.filter((r) => {
    if (r.startTime == null) return false;
    const t = new Date(r.startTime).getTime();
    return Number.isFinite(t) && t >= startMs;
  });
}

export interface HistoryKpis {
  readonly spendUsd: number;
  readonly sessionCount: number;
  readonly avgEfficiency: number | null;
  readonly avgCostPerSession: number | null;
  readonly flags: number;
}

export function computeHistoryKpis(rows: SessionRow[]): HistoryKpis {
  let spend = 0;
  let effSum = 0;
  let effCount = 0;
  let flags = 0;
  for (const r of rows) {
    if (r.estimatedCostUsd != null) spend += r.estimatedCostUsd;
    if (r.efficiencyScore != null) {
      effSum += r.efficiencyScore;
      effCount++;
    }
    flags += r.antiPatterns?.length ?? 0;
  }
  return {
    spendUsd: spend,
    sessionCount: rows.length,
    avgEfficiency: effCount > 0 ? effSum / effCount : null,
    avgCostPerSession: rows.length > 0 ? spend / rows.length : null,
    flags,
  };
}

export function buildOutcomeData(
  resp: CostPerOutcomeResponse | undefined,
): Array<{ outcome: string; totalCost: number; count: number }> {
  if (!resp) return [];
  return (
    Object.entries(resp.outcomeDistribution)
      .map(([outcome, b]) => ({
        outcome: outcome.replace(/_/g, ' '),
        totalCost: Number(b.totalCost.toFixed(2)),
        count: b.count,
      }))
      // Drop zero-cost outcomes so a distribution with $0 entries doesn't
      // render a row of empty bars.
      .filter((d) => d.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost)
  );
}

/**
 * Pad daily-cost data to a fixed window of `days` columns ending today.
 * Days with no recorded cost are emitted with `cost: 0` so the chart
 * renders a full `days`-column bar chart instead of stretching a single
 * bar to fill the entire plot area.
 */
export function padDailyCostWindow(
  data: Array<{ day: string; cost: number }>,
  days: number,
  today: Date = new Date(),
): Array<{ day: string; cost: number }> {
  const byDay = new Map(data.map((d) => [d.day, d.cost]));
  const out: Array<{ day: string; cost: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ day: key, cost: byDay.get(key) ?? 0 });
  }
  return out;
}

export function buildAntiPatternSeries(weeks: WeeklyRow[]): Array<{ week: string; count: number }> {
  const out: Array<{ week: string; count: number }> = [];
  for (const w of weeks) {
    const counts = w.antiPatternCounts ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    out.push({ week: w.week || '?', count: total });
  }
  return out;
}

export interface ModelPerformanceRow {
  readonly model: string;
  readonly sessions: number;
  readonly avgEfficiency: number | null;
  readonly avgSuccessRate: number | null;
  readonly avgCost: number | null;
  // Blended rate across sessions for this model that report both cost and
  // token counts — (totalCost / totalTokens) * 1e6, input+output tokens only
  // (matching ModelUsageTracker's server-side per-model figure, which is a
  // different token set than CostTracker's session-blended rate). Unlike
  // avgCost (a mean of per-session costs), this is stable across sessions of
  // very different size, so it's the more meaningful number for comparing
  // models' actual spend efficiency.
  readonly costPerMillionTokens: number | null;
  readonly flagged: boolean;
}

function modelSharePct(row: ModelPerformanceRow, totalCost: number): number | null {
  if (totalCost <= 0 || row.avgCost == null) return null;
  return ((row.avgCost * row.sessions) / totalCost) * 100;
}

const FLAGGED_SUCCESS_THRESHOLD = 0.85;
// A single low-success session shouldn't carry the same visual weight for a
// model with 50 sessions as it does for a model with 2 — flag a model only
// once a meaningful share of its sessions fall below FLAGGED_SUCCESS_THRESHOLD.
const FLAGGED_LOW_SUCCESS_PROPORTION = 0.3;

export function aggregateModelPerformance(rows: SessionRow[]): ModelPerformanceRow[] {
  const byModel = new Map<
    string,
    {
      sessions: number;
      effSum: number;
      effCount: number;
      successSum: number;
      successCount: number;
      costSum: number;
      costCount: number;
      blendedCostSum: number;
      blendedTokensSum: number;
      lowSuccessSessions: number;
    }
  >();

  for (const r of rows) {
    const model = r.model ?? 'unknown';
    let entry = byModel.get(model);
    if (!entry) {
      entry = {
        sessions: 0,
        effSum: 0,
        effCount: 0,
        successSum: 0,
        successCount: 0,
        costSum: 0,
        costCount: 0,
        blendedCostSum: 0,
        blendedTokensSum: 0,
        lowSuccessSessions: 0,
      };
      byModel.set(model, entry);
    }
    entry.sessions++;
    if (r.efficiencyScore != null) {
      entry.effSum += r.efficiencyScore;
      entry.effCount++;
    }
    if (r.toolSuccessRate != null) {
      entry.successSum += r.toolSuccessRate;
      entry.successCount++;
      if (r.toolSuccessRate < FLAGGED_SUCCESS_THRESHOLD) {
        entry.lowSuccessSessions++;
      }
    }
    if (r.estimatedCostUsd != null) {
      entry.costSum += r.estimatedCostUsd;
      entry.costCount++;
      // Only blend cost and tokens from the same session — a live session row
      // can carry a cost before its token counts have been persisted, which
      // would otherwise inflate costPerMillionTokens by counting cost against
      // fewer tokens than were actually spent. The schema guarantees non-null
      // token defaults, so guard on an actual positive token count rather
      // than null-ness (a session with real cost but zero recorded tokens
      // would otherwise pass the null check and inflate the blended rate).
      const sessionTokens =
        (r.tokensInput ?? 0) +
        (r.tokensOutput ?? 0) +
        (r.tokensThinking ?? 0) +
        (r.tokensCacheRead ?? 0) +
        (r.tokensCacheCreation ?? 0);
      if (sessionTokens > 0) {
        entry.blendedCostSum += r.estimatedCostUsd;
        entry.blendedTokensSum += sessionTokens;
      }
    }
  }

  const result: ModelPerformanceRow[] = [];
  for (const [model, e] of byModel) {
    result.push({
      model,
      sessions: e.sessions,
      avgEfficiency: e.effCount > 0 ? e.effSum / e.effCount : null,
      avgSuccessRate: e.successCount > 0 ? e.successSum / e.successCount : null,
      avgCost: e.costCount > 0 ? e.costSum / e.costCount : null,
      costPerMillionTokens:
        e.blendedTokensSum > 0 ? (e.blendedCostSum / e.blendedTokensSum) * 1_000_000 : null,
      flagged:
        e.successCount > 0 &&
        e.lowSuccessSessions / e.successCount > FLAGGED_LOW_SUCCESS_PROPORTION,
    });
  }

  return result.sort((a, b) => b.sessions - a.sessions);
}

export function aggregateToolUsage(rows: SessionRow[]): Array<{ tool: string; count: number }> {
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
export function buildToolTableRows(rows: SessionRow[]): ToolTableRow[] {
  const tools = aggregateToolUsage(rows);
  const total = tools.reduce((sum, t) => sum + t.count, 0);
  return tools.map((t) => ({
    tool: shortToolName(t.tool),
    count: t.count,
    sharePct: total > 0 ? (t.count / total) * 100 : 0,
  }));
}

// Tooltip positioning here was previously `left: tooltip.x` (raw px in
// viewBox units), which misaligned by hundreds of pixels at any non-native
// render width. Routing through the shared `DiscreteBlockChart` fixes that
// for free — the shared component measures the rendered column via
// `getBoundingClientRect` instead of deriving position from the viewBox,
// so it survives the SVG's `xMidYMax meet` scaling.
function ConcurrencyBlockChart({
  data,
}: {
  data: ReadonlyArray<{ readonly date: string; readonly peak: number }>;
}): JSX.Element | null {
  const items: DiscreteBlockChartItem[] = data.map((day) => ({
    count: day.peak,
    tooltip: `${day.date.slice(5)}: ${day.peak}`,
  }));
  return (
    <DiscreteBlockChart
      data={items}
      ariaLabel={`Peak concurrent sessions over ${data.length} days`}
    />
  );
}
