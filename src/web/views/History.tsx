import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../components/EmptyState';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { GeoBanner } from '../components/GeoBanner';
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
import {
  fetchWeekly,
  fetchSessionsList,
  fetchCostPerOutcome,
  fetchPersonalCoach,
  fetchActivityHeatmap,
  fetchConcurrencyHistory,
  qk,
} from '../api/client';
import { shortToolName } from '../lib/format';

interface WeeklyRow {
  readonly weekStart?: string;
  readonly week?: string;
  readonly efficiencyScore?: number;
  readonly avgEfficiencyScore?: number | null;
  readonly totalCostUsd: number;
  readonly antiPatternCounts?: Record<string, number>;
}

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string | number;
  readonly estimatedCostUsd?: number | null;
  readonly model?: string | null;
  readonly toolSuccessRate?: number | null;
  readonly efficiencyScore?: number | null;
  readonly toolCallCount?: number;
  readonly toolBreakdown?: Record<string, number>;
}

interface HistoryHeatmapResponse {
  readonly days: Array<{ date: string; count: number }>;
  readonly maxCount: number;
}

interface ConcurrencyHistoryResponse {
  readonly dailyPeaks: Array<{ date: string; peak: number }>;
}

interface OutcomeBucket {
  readonly count: number;
  readonly totalCost: number;
  readonly avgCost: number;
}

interface CostPerOutcomeResponse {
  readonly outcomeDistribution: Record<string, OutcomeBucket>;
  readonly wasteRatio: number;
  readonly totalCost: number;
  readonly totalTasks: number;
}

interface PersonalCoachOk {
  readonly status: 'ok';
  readonly highlights: readonly string[];
  readonly regressions: readonly string[];
  readonly streaks: readonly string[];
  readonly topRecommendation: string;
}

interface PersonalCoachInsufficient {
  readonly status: 'insufficient_data';
  readonly message: string;
}

type PersonalCoachResult = PersonalCoachOk | PersonalCoachInsufficient;

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
    queryFn: () => fetchWeekly() as Promise<WeeklyRow[]>,
  });

  const sessions = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(200),
    queryFn: () => fetchSessionsList(200) as Promise<SessionRow[]>,
  });

  const costPerOutcome = useQuery<CostPerOutcomeResponse>({
    queryKey: qk.costPerOutcome(30),
    queryFn: () => fetchCostPerOutcome(30) as Promise<CostPerOutcomeResponse>,
  });

  const coach = useQuery<PersonalCoachResult>({
    queryKey: qk.personalCoach,
    queryFn: () => fetchPersonalCoach() as Promise<PersonalCoachResult>,
  });

  const activityGrid = useQuery<HistoryHeatmapResponse>({
    queryKey: qk.activityHeatmap('history'),
    queryFn: () => fetchActivityHeatmap('history', 12) as Promise<HistoryHeatmapResponse>,
  });

  const concurrencyHistory = useQuery<ConcurrencyHistoryResponse>({
    queryKey: qk.concurrencyHistory(30),
    queryFn: () => fetchConcurrencyHistory(30) as Promise<ConcurrencyHistoryResponse>,
  });

  // API returns newest-first; reverse for chronological left-to-right chart rendering
  const weeklyChronological = [...(weekly.data ?? [])].reverse();
  const weeklyData = weeklyChronological.map((w) => {
    const fullDate = w.weekStart ?? w.week ?? '';
    const score = w.efficiencyScore ?? w.avgEfficiencyScore ?? null;
    return { week: fullDate || '?', efficiency: score !== null ? Math.round(score * 100) : null };
  });

  const dailyData = aggregateDailyCost(sessions.data ?? [], 30);
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

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Weekly efficiency · last 8">
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

        <Panel title="Daily spend · last 30 days">
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
                <XAxis dataKey="day" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="cost" fill="url(#costGradient)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Cost per outcome · last 30 days">
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

        <Panel title="Anti-pattern frequency · weekly">
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

        <Panel title="Model performance">
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
                      <td className="py-1 text-right tabular-nums">
                        {m.avgCost !== null ? `$${m.avgCost.toFixed(2)}` : '—'}
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

        <Panel title="Top tools · all sessions">
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
          <Panel title="Activity · last 12 weeks">
            <ActivityHeatmap
              variant="grid"
              buckets={[]}
              maxCount={activityGrid.data.maxCount}
              days={activityGrid.data.days}
              ariaLabel="Daily activity heatmap for the last 4 weeks"
            />
          </Panel>
        )}

        {hasConcurrencyData && (
          <div className="glass-card p-4 flex flex-col">
            <div className="text-[11px] text-ink-muted uppercase tracking-wider font-medium mb-3">
              Peak sessions · all-time: {Math.max(...concurrencyData.map((d) => d.peak))}
            </div>
            <div className="flex-1 flex items-end justify-center">
              <ConcurrencyBlockChart data={concurrencyData} />
            </div>
          </div>
        )}
      </div>

      <div className="mt-3">
        <CoachCard data={coach.data} />
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="glass-card p-4">
      <div className="text-[11px] text-ink-muted uppercase tracking-wider font-medium mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}

function CoachCard({ data }: { data: PersonalCoachResult | undefined }): JSX.Element {
  if (!data) {
    return (
      <Panel title="Personal coach">
        <div className="text-ink-muted text-xs">Loading coaching insights…</div>
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
        <div>
          <span className="text-accent-cyan font-semibold">Top recommendation: </span>
          {data.topRecommendation}
        </div>
        {data.highlights.length > 0 && (
          <ul className="list-disc list-inside text-emerald-400">
            {data.highlights.map((h) => (
              <li key={`hl-${h}`}>{h}</li>
            ))}
          </ul>
        )}
        {data.regressions.length > 0 && (
          <ul className="list-disc list-inside text-amber-400">
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
  return Object.entries(resp.outcomeDistribution)
    .map(([outcome, b]) => ({
      outcome: outcome.replace(/_/g, ' '),
      totalCost: Number(b.totalCost.toFixed(2)),
      count: b.count,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

export function buildAntiPatternSeries(weeks: WeeklyRow[]): Array<{ week: string; count: number }> {
  const out: Array<{ week: string; count: number }> = [];
  for (const w of weeks) {
    const counts = w.antiPatternCounts ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      out.push({ week: (w.weekStart ?? w.week ?? '') || '?', count: total });
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

const BLOCK_COLOR = 'rgba(0, 212, 170, 0.7)';
const BLOCK_COLOR_PEAK_CELL = 'rgba(0, 212, 170, 1)';

function ConcurrencyBlockChart({
  data,
}: {
  data: Array<{ date: string; peak: number }>;
}): JSX.Element {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const maxPeak = Math.max(...data.map((d) => d.peak), 1);

  const blockSize = 10;
  const blockGap = 2;
  const colGap = 3;
  const colWidth = blockSize + colGap;
  const chartHeight = maxPeak * (blockSize + blockGap);
  const chartWidth = data.length * colWidth;

  return (
    <div className="relative">
      <svg
        width="100%"
        height={chartHeight}
        role="img"
        aria-label={`Peak concurrent sessions over ${data.length} days`}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="xMidYMax meet"
        onMouseLeave={() => setTooltip(null)}
      >
        {data.map((day, colIdx) => {
          const blocks: JSX.Element[] = [];
          for (let b = 0; b < day.peak; b++) {
            const isMax = day.peak === maxPeak;
            blocks.push(
              <rect
                key={`${colIdx}-${b}`}
                x={colIdx * colWidth}
                y={chartHeight - (b + 1) * (blockSize + blockGap)}
                width={blockSize}
                height={blockSize}
                rx={1}
                fill={isMax ? BLOCK_COLOR_PEAK_CELL : BLOCK_COLOR}
                className="heatmap-cell"
                style={{ animationDelay: `${colIdx * 10 + b * 8}ms` }}
              />,
            );
          }
          return (
            <g
              key={colIdx}
              onMouseEnter={() => {
                setTooltip({
                  x: colIdx * colWidth,
                  y: chartHeight - day.peak * (blockSize + blockGap) - 14,
                  text: `${day.date.slice(5)}: ${day.peak}`,
                });
              }}
            >
              <rect
                x={colIdx * colWidth}
                y={0}
                width={colWidth}
                height={chartHeight}
                fill="transparent"
              />
              {blocks}
            </g>
          );
        })}
      </svg>
      {tooltip && (
        <div
          className="absolute px-1.5 py-0.5 bg-bg-elevated text-[10px] text-ink-default rounded shadow-md pointer-events-none whitespace-nowrap"
          style={{ left: tooltip.x, top: Math.max(0, tooltip.y) }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
