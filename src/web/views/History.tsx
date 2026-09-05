import type { JSX } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

import { EmptyState } from '../components/EmptyState';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
import { DiscreteBlockChart, type DiscreteBlockChartItem } from '../components/DiscreteBlockChart';
import { Card, Eyebrow, InfoTooltip, Pill, type PillTone } from '../components/ui';
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
} from '../api/client';
import { formatUsdOrDash, shortToolName } from '../lib/format';

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
}

const TICK_STYLE = { fill: 'var(--color-ink-muted)', fontSize: 10 };
const GRID_STROKE = 'var(--color-border-subtle)';
const TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-medium)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-ink-base)',
};
// Recharts falls back to a hardcoded #000 for tooltip item text whenever the
// series has no explicit fill/stroke (e.g. Bars colored per-entry via Cell).
// TOOLTIP_STYLE.color only reaches the tooltip label, not item rows, so this
// has to be passed separately as `itemStyle`.
const TOOLTIP_ITEM_STYLE = { color: 'var(--color-ink-base)' };
const ACCENT = 'var(--color-accent-green)';
const ACCENT_AMBER = 'var(--color-accent-amber)';
const ACCENT_GREEN = 'var(--color-accent-green)';
const ACCENT_PURPLE = 'var(--color-accent-purple)';
const ACCENT_BLUE = 'var(--color-accent-blue)';
const ACCENT_TEAL = 'var(--color-accent-teal)';

function toolFillColor(toolName: string): string {
  if (toolName === 'Read') return ACCENT_BLUE;
  if (toolName === 'Edit' || toolName === 'Write') return ACCENT_GREEN;
  if (toolName === 'Bash') return ACCENT_PURPLE;
  if (toolName === 'Agent') return ACCENT_TEAL;
  return 'var(--color-ink-muted)';
}

function outcomeFillColor(outcome: string): string {
  const lower = outcome.toLowerCase();
  if (lower === 'bug fix' || lower === 'fix') return '#FF6B6B';
  if (lower === 'feature') return ACCENT_GREEN;
  if (lower === 'refactor') return ACCENT_BLUE;
  if (lower === 'configuration' || lower === 'config') return ACCENT_AMBER;
  if (lower === 'test') return ACCENT_TEAL;
  if (lower === 'docs') return '#C4B5FD';
  return ACCENT_PURPLE;
}

// Render only the month-day portion of an ISO `YYYY-MM-DD` axis label
// while keeping the full year-prefixed string in the chart data so
// cross-year ticks remain unique.
function shortMonthDay(value: string): string {
  return typeof value === 'string' && value.length >= 10 ? value.slice(5, 10) : value;
}

const INSTRUCTION_DRIFT_TOOLTIP =
  "Compares session outcomes before and after your most recent change to an instruction file (CLAUDE.md, or the active platform's equivalent) — success rate, token usage, and thrashing incidents. A degraded verdict means sessions got worse after the edit, not better.";

function DriftStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</div>
      <div className="text-sm font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function InstructionDriftCard({
  data,
}: {
  data: InstructionDriftResponse | undefined;
}): JSX.Element {
  if (!data) {
    return (
      <Panel title="Instruction Drift" tooltip={INSTRUCTION_DRIFT_TOOLTIP}>
        <EmptyState variant="loading" title="Loading drift data…" />
      </Panel>
    );
  }
  const latest = data.recentCorrelations[data.recentCorrelations.length - 1];
  if (!latest) {
    return (
      <Panel title="Instruction Drift" tooltip={INSTRUCTION_DRIFT_TOOLTIP}>
        <div className="text-ink-muted text-xs">No instruction file changes tracked yet.</div>
      </Panel>
    );
  }
  const verdictTone: Record<DriftCorrelationEntry['verdict'], PillTone> = {
    improved: 'success',
    degraded: 'danger',
    neutral: 'neutral',
    insufficient_data: 'neutral',
  };
  return (
    <Panel
      title="Instruction Drift — most recent instruction file change"
      tooltip={INSTRUCTION_DRIFT_TOOLTIP}
    >
      <div className="flex items-center gap-6">
        <Pill tone={verdictTone[latest.verdict]}>{latest.verdict}</Pill>
        <DriftStat
          label="Success"
          value={
            latest.successRateDelta !== null
              ? `${latest.successRateDelta > 0 ? '+' : ''}${Math.round(latest.successRateDelta * 100)}%`
              : '—'
          }
        />
        <DriftStat
          label="Tokens"
          value={`${latest.tokensDelta > 0 ? '+' : ''}${latest.tokensDelta}`}
        />
        <DriftStat
          label="Thrashing"
          value={`${latest.thrashingDelta > 0 ? '+' : ''}${latest.thrashingDelta}`}
        />
      </div>
    </Panel>
  );
}

export function History(): JSX.Element {
  const weekly = useQuery<WeeklyRow[]>({
    queryKey: qk.weekly,
    queryFn: fetchWeekly,
  });

  const sessions = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200),
  });

  const costPerOutcome = useQuery<CostPerOutcomeResponse>({
    queryKey: qk.costPerOutcome(30),
    queryFn: () => fetchCostPerOutcome(30),
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
    queryKey: qk.concurrencyHistory(30),
    queryFn: () => fetchConcurrencyHistory(30),
  });

  const drift = useQuery<InstructionDriftResponse>({
    queryKey: qk.instructionDrift,
    queryFn: fetchInstructionDrift,
  });

  const hasLoadError =
    weekly.isError || sessions.isError || costPerOutcome.isError || concurrencyHistory.isError;

  // API returns newest-first; reverse for chronological left-to-right chart rendering
  const weeklyChronological = [...(weekly.data ?? [])].reverse();
  const weeklyData = weeklyChronological.map((w) => {
    const score = w.avgEfficiencyScore;
    return { week: w.week || '?', efficiency: score !== null ? Math.round(score * 100) : null };
  });

  const dailyData = padDailyCostWindow(aggregateDailyCost(sessions.data ?? [], 30), 30);
  // The 200-session sample can run out before it reaches back the full
  // 30-day window (a busy account can churn through 200 sessions in far
  // fewer than 30 days). When it does, the padded $0 days at the start of
  // the window aren't confirmed zero-spend — they're simply outside the
  // sample's reach. Flag that instead of presenting them as real zeros.
  // Only flag it when the sample actually hit the 200-row cap; an account
  // with fewer than 200 total sessions has nothing withheld, so its early
  // zero-padded days are confirmed zero-spend rather than unsampled.
  const dailySpendTruncated =
    (sessions.data?.length ?? 0) >= 200 && isDailySpendSampleTruncated(sessions.data ?? [], 30);
  const outcomeData = buildOutcomeData(costPerOutcome.data);
  const antiPatternSeries = buildAntiPatternSeries(weeklyChronological);
  const modelPerf = aggregateModelPerformance(sessions.data ?? []);
  const topTools = aggregateToolUsage(sessions.data ?? []);
  // aggregateToolUsage caps at the top 8 tools; surface how many were
  // dropped so "Top Tools" doesn't read as an exhaustive list.
  const totalToolCount = new Set(
    (sessions.data ?? []).flatMap((r) => (r.toolBreakdown ? Object.keys(r.toolBreakdown) : [])),
  ).size;
  const hiddenToolCount = Math.max(0, totalToolCount - topTools.length);
  const concurrencyData = concurrencyHistory.data?.dailyPeaks ?? [];
  const hasConcurrencyData = concurrencyData.some((d) => d.peak > 0);

  return (
    <section>
      <GeoBanner theme="history" />
      <h1 className="text-xl font-semibold gradient-text mb-4">History</h1>

      {hasLoadError && (
        <div className="text-accent-red text-xs mb-3">
          Error loading some history data. Charts below may be incomplete.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Weekly Efficiency · Last 12">
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
                  tickFormatter={shortMonthDay}
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

        <Panel title="Daily Spend · Last 30 Days (most recent 200)">
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
                  tickFormatter={shortMonthDay}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                {/* cursor={false}: with 30 days padded, most bars are zero.
                    Recharts' default cursor draws a full-height rectangle
                    over the hovered slot, which reads as a phantom bar on
                    empty days. The tooltip already labels the date. */}
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(label) => shortMonthDay(String(label))}
                  cursor={false}
                />
                <Bar dataKey="cost" fill="url(#costGradient)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {dailySpendTruncated && (
            <div className="text-[10px] text-ink-muted italic mt-1">
              Sample doesn&apos;t reach back 30 days — early days in this chart may undercount
              actual spend.
            </div>
          )}
        </Panel>

        <Panel title="Cost Per Outcome · Last 30 Days">
          {outcomeData.length === 0 ? (
            <EmptyState
              icon="radar"
              title="No outcomes yet"
              subtitle="Finish a few sessions and check back."
            />
          ) : (
            <div
              className="min-w-0"
              style={{ height: `${Math.max(176, outcomeData.length * 32 + 40)}px` }}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart data={outcomeData} layout="vertical">
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis type="number" tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                  <YAxis
                    type="category"
                    dataKey="outcome"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    width={110}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} />
                  <Bar dataKey="totalCost" radius={[0, 3, 3, 0]}>
                    {outcomeData.map((entry) => (
                      <Cell
                        key={entry.outcome}
                        fill={outcomeFillColor(entry.outcome)}
                        fillOpacity={0.8}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Anti-Pattern Frequency · Weekly">
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
                    tickFormatter={shortMonthDay}
                  />
                  <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" fill="url(#antiPatternGradient)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Model Performance · Most Recent 200 Sessions">
          {modelPerf.length === 0 ? (
            <EmptyState
              icon="radar"
              title="No model data yet"
              subtitle="Complete a few sessions to see model performance."
            />
          ) : (
            <div className="h-44 overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="text-ink-muted sticky top-0 bg-bg-panel">
                  <tr>
                    <th className="text-left pb-1">Model</th>
                    <th className="text-right pb-1">Sessions</th>
                    <th className="text-right pb-1">Eff.</th>
                    <th className="text-right pb-1">Success</th>
                    <th className="text-right pb-1">Avg $</th>
                    <th className="text-right pb-1">$/1M tok</th>
                  </tr>
                </thead>
                <tbody>
                  {modelPerf.map((m) => (
                    <tr key={m.model} className="border-t border-bg-line">
                      <td className="py-1 font-medium">{m.model}</td>
                      <td className="py-1 text-right tabular-nums">{m.sessions}</td>
                      <td className="py-1 text-right tabular-nums">
                        {m.avgEfficiency !== null
                          ? `${Math.min(100, Math.round(m.avgEfficiency * 100))}%`
                          : '—'}
                      </td>
                      <td
                        className={`py-1 text-right tabular-nums ${m.flagged ? 'text-accent-amber' : ''}`}
                      >
                        {m.avgSuccessRate !== null
                          ? `${Math.min(100, Math.round(m.avgSuccessRate * 100))}%`
                          : '—'}
                      </td>
                      <td className="py-1 text-right tabular-nums">{formatUsdOrDash(m.avgCost)}</td>
                      <td className="py-1 text-right tabular-nums text-ink-subtle">
                        {formatUsdOrDash(m.costPerMillionTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {modelPerf.some((m) => m.flagged) && (
                <div className="text-accent-amber text-[10px] mt-1">
                  ⚠ Highlighted models had sessions with elevated error rates
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Top Tools · Most Recent 200 Sessions">
          {topTools.length === 0 ? (
            <EmptyState
              icon="code"
              title="No tool data yet"
              subtitle="Tool usage data will appear after coding sessions."
            />
          ) : (
            <div
              className="min-w-0"
              style={{ height: `${Math.max(176, topTools.length * 28 + 40)}px` }}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart data={topTools} layout="vertical">
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis type="number" tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <YAxis
                    type="category"
                    dataKey="tool"
                    tick={TICK_STYLE}
                    tickFormatter={shortToolName}
                    stroke={GRID_STROKE}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                    labelFormatter={(label) => shortToolName(String(label))}
                  />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {topTools.map((entry) => (
                      <Cell
                        key={entry.tool}
                        fill={toolFillColor(shortToolName(entry.tool))}
                        fillOpacity={0.8}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {hiddenToolCount > 0 && (
            <div className="text-[10px] text-ink-muted italic mt-1">
              +{hiddenToolCount} more tool{hiddenToolCount === 1 ? '' : 's'} not shown
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        {activityGrid.data && activityGrid.data.days.length > 0 && (
          <Panel title="Activity · Last 12 Weeks">
            <ActivityHeatmap
              variant="grid"
              buckets={[]}
              maxCount={activityGrid.data.maxCount}
              days={activityGrid.data.days}
              ariaLabel="Daily activity heatmap for the last 12 weeks"
            />
          </Panel>
        )}

        {/* Always render the panel so it doesn't silently disappear on
            a fresh install with no historical concurrency yet — the
            dashboard previously omitted the entire Panel when every
            day's peak was 0, which read as a missing feature. */}
        <Card padding="md" className="flex flex-col">
          <Eyebrow className="mb-3">
            Peak Concurrent Sessions · Last 30 Days
            {hasConcurrencyData && `: ${Math.max(...concurrencyData.map((d) => d.peak))}`}
          </Eyebrow>
          {hasConcurrencyData ? (
            <div className="flex-1 flex items-end justify-center">
              <ConcurrencyBlockChart data={concurrencyData} />
            </div>
          ) : (
            <EmptyState
              icon="code"
              title="No concurrent sessions yet"
              subtitle="Run two or more Claude Code sessions at the same time to populate this chart."
            />
          )}
        </Card>
      </div>

      <div className="mt-3 space-y-3">
        <CollaborationProfilePanel data={collabProfile.data} isError={collabProfile.isError} />
        <ClaudeMdImpactPanel data={claudeMdImpact.data} isError={claudeMdImpact.isError} />
      </div>

      <div className="mt-3">
        <InstructionDriftCard data={drift.data} />
      </div>

      <div className="mt-3">
        <CoachCard data={coach.data} />
      </div>

      <div className="mt-3">
        <RecommendationsPanel data={recommendations.data} isError={recommendations.isError} />
      </div>
    </section>
  );
}

function Panel({
  title,
  tooltip,
  children,
}: {
  title: string;
  tooltip?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card padding="md">
      <div className="flex items-center gap-1.5">
        <Eyebrow>{title}</Eyebrow>
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
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

  function pctDeltaText(delta: number | null): string {
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
      <span className="font-mono">${thisWeek.avgCostPerSession.toFixed(2)}</span>
      <span className={costColor(costDelta)}>{pctDeltaText(costDelta)}</span>

      <span className="text-ink-muted">Anti-pattern rate</span>
      <span className="font-mono">{(thisWeek.antiPatternRate * 100).toFixed(1)}%</span>
      <span className={apColor(apDelta)}>{pctDeltaText(apDelta)}</span>

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
          icon="radar"
          title="No recommendations yet"
          subtitle="Keep using Preflight — recommendations appear after a few sessions of data."
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

function ClaudeMdImpactPanel({
  data,
  isError,
}: {
  data: ClaudeMdImpactApiResponse | undefined;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return (
      <Panel title="Instruction File Impact">
        <EmptyState icon="radar" title="Instruction file impact unavailable" />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="Instruction File Impact">
        <EmptyState variant="loading" title="Loading instruction file impact…" />
      </Panel>
    );
  }
  if (
    data.message ||
    !data.change ||
    !data.before ||
    !data.after ||
    !data.deltas ||
    !data.verdict
  ) {
    return (
      <Panel title="Instruction File Impact">
        <EmptyState
          icon="radar"
          title="No instruction file changes yet"
          subtitle="Edit your instruction file (CLAUDE.md, or your platform's equivalent) to start tracking impact."
        />
      </Panel>
    );
  }
  const changeDate = new Date(data.change.timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const beforeEff =
    data.before.avgEfficiencyScore !== null
      ? Math.round(data.before.avgEfficiencyScore * 100)
      : null;
  const afterEff =
    data.after.avgEfficiencyScore !== null ? Math.round(data.after.avgEfficiencyScore * 100) : null;
  return (
    <Panel title="Instruction File Impact">
      <div className="text-xs mb-3">
        <span className={`font-medium ${verdictColor(data.verdict)}`}>{data.verdict}</span>
        <span className="text-[10px] text-ink-muted">
          {' · '}
          {data.change.changeType} {data.change.filePath.split('/').pop()} · {changeDate}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <span className="text-ink-muted" />
        {/* Sample size next to each column — a 1-vs-1 session comparison
            shouldn't read with the same confidence as a 50-vs-50 one. */}
        <span className="text-ink-muted">Before (n={data.before.sessionCount})</span>
        <span className="text-ink-muted">After (n={data.after.sessionCount})</span>
        <span className="text-ink-muted">Δ</span>

        <span className="text-ink-muted">Efficiency</span>
        <span className="font-mono">{beforeEff ?? '—'}</span>
        <span className="font-mono">{afterEff ?? '—'}</span>
        <span
          className={
            data.deltas.efficiencyScore == null
              ? 'text-ink-muted'
              : data.deltas.efficiencyScore.improved
                ? 'text-accent-green'
                : 'text-accent-amber'
          }
        >
          {ptsDeltaText(data.deltas.efficiencyScore)}
        </span>

        <span className="text-ink-muted">Cost/session</span>
        <span className="font-mono">${data.before.avgCostUsd.toFixed(2)}</span>
        <span className="font-mono">${data.after.avgCostUsd.toFixed(2)}</span>
        <span className={data.deltas.cost.improved ? 'text-accent-green' : 'text-accent-amber'}>
          {pctDeltaText(data.deltas.cost)}
        </span>

        <span className="text-ink-muted">Correction rate</span>
        <span className="font-mono">{Math.round(data.before.avgCorrectionRate * 100)}%</span>
        <span className="font-mono">{Math.round(data.after.avgCorrectionRate * 100)}%</span>
        <span
          className={
            data.deltas.correctionRate.improved ? 'text-accent-green' : 'text-accent-amber'
          }
        >
          {pctDeltaText(data.deltas.correctionRate)}
        </span>
      </div>
      {data.contextTokensForClaudeMd != null && data.contextTokensForClaudeMd > 0 && (
        <div className="text-[10px] text-ink-muted italic mt-2">
          Instruction file adds ~{data.contextTokensForClaudeMd.toLocaleString()} tokens/turn
        </div>
      )}
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
      <Panel title="Collaboration Profile">
        <EmptyState icon="radar" title="Collaboration profile unavailable" />
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="Collaboration Profile">
        <EmptyState variant="loading" title="Loading collaboration profile…" />
      </Panel>
    );
  }
  if (data.sessionCount === 0) {
    return (
      <Panel title="Collaboration Profile">
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
  return (
    <Panel title="Collaboration Profile">
      <div className="text-xs mb-3">
        <span className="text-sm font-medium text-ink-base">{data.classification}</span>
        <span className="text-ink-muted"> · {data.sessionCount} sessions</span>
      </div>
      {/* The "vs team" deltas below are computed against a baseline of
          whatever developers have recorded sessions. With developerCount <= 1
          that baseline is just this developer, so every delta is trivially
          ~0 and reads as "right on target" rather than "no comparison data
          exists yet". */}
      {data.developerCount <= 1 && (
        <div className="text-[10px] text-ink-muted italic mb-2">
          No team data yet — &quot;vs team&quot; comparisons below will reflect other developers
          once their sessions are recorded.
        </div>
      )}
      <div className="min-w-0" style={{ height: `${dims.length * 28 + 40}px` }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
          <BarChart data={dims} layout="vertical">
            <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
            <XAxis
              type="number"
              domain={[0, 100]}
              tick={TICK_STYLE}
              stroke={GRID_STROKE}
              tickFormatter={(v: number) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={TICK_STYLE}
              stroke={GRID_STROKE}
              width={110}
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`]} />
            <Bar dataKey="value" fill={ACCENT_TEAL} fillOpacity={0.8} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-1 mt-2">
        {dims.map((d) => {
          const pct = Math.round(Math.abs(d.delta) * 100);
          const positive = d.lowerIsBetter ? d.delta < 0 : d.delta > 0;
          const color =
            d.delta === 0 ? 'text-ink-muted' : positive ? 'text-accent-green' : 'text-accent-amber';
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
    </Panel>
  );
}

function CoachCard({ data }: { data: PersonalCoachResult | undefined }): JSX.Element {
  if (!data) {
    return (
      <Panel title="Personal Coach">
        <EmptyState variant="loading" title="Loading coaching insights…" />
      </Panel>
    );
  }
  if (data.status === 'insufficient_data') {
    return (
      <Panel title="Personal Coach">
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
      // Drop zero-cost outcomes. Recharts auto-domains a horizontal bar chart
      // whose only data points are zero into a default [0,4] range, which
      // renders an empty plot area that visually reads as a full-width bar
      // even though the underlying value is 0. Filtering here lets the
      // existing `outcomeData.length === 0` empty-state branch take over.
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
