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
import { Card, Eyebrow } from '../components/ui';
import {
  fetchWeekly,
  fetchSessionsList,
  fetchCostPerOutcome,
  fetchPersonalCoach,
  fetchActivityHeatmap,
  fetchConcurrencyHistory,
  qk,
  type WeeklyRow,
  type CostPerOutcomeResponse,
  type PersonalCoachResult,
  type ConcurrencyHistoryResponse,
  type ActivityHeatmapHistoryResponse,
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

  const activityGrid = useQuery<ActivityHeatmapHistoryResponse>({
    queryKey: qk.activityHeatmap('history'),
    queryFn: () => fetchActivityHeatmap('history', 12),
  });

  const concurrencyHistory = useQuery<ConcurrencyHistoryResponse>({
    queryKey: qk.concurrencyHistory(30),
    queryFn: () => fetchConcurrencyHistory(30),
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
  const outcomeData = buildOutcomeData(costPerOutcome.data);
  const antiPatternSeries = buildAntiPatternSeries(weeklyChronological);
  const modelPerf = aggregateModelPerformance(sessions.data ?? []);
  const topTools = aggregateToolUsage(sessions.data ?? []);
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
                  labelFormatter={shortMonthDay}
                  cursor={false}
                />
                <Bar dataKey="cost" fill="url(#costGradient)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
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
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
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
          {antiPatternSeries.length === 0 ? (
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

        <Panel title="Model Performance">
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
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={shortToolName} />
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

      <div className="mt-3">
        <CoachCard data={coach.data} />
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Card padding="md">
      <Eyebrow>{title}</Eyebrow>
      <div className="mt-3">{children}</div>
    </Card>
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
 * renders a 30-column bar chart instead of stretching a single bar to
 * fill the entire plot area.
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
    if (total > 0) {
      out.push({ week: w.week || '?', count: total });
    }
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
      // fewer tokens than were actually spent.
      if (r.tokensInput != null || r.tokensOutput != null) {
        entry.blendedCostSum += r.estimatedCostUsd;
        entry.blendedTokensSum += (r.tokensInput ?? 0) + (r.tokensOutput ?? 0);
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
      flagged: e.lowSuccessSessions > 0,
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
// for free — the shared component uses %-based positioning that survives
// the SVG's `xMidYMax meet` scaling.
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
