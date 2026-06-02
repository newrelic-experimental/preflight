import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
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
  qk,
} from '../api/client';

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

const TICK_STYLE = { fill: '#94a3b8', fontSize: 10 };
const GRID_STROKE = '#1e293b';
const ACCENT = '#22d3ee';
const ACCENT_AMBER = '#f59e0b';

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

  const weeklyData = (weekly.data ?? []).map((w) => {
    const label = (w.weekStart ?? w.week ?? '').slice(5) || '?';
    const score = w.efficiencyScore ?? w.avgEfficiencyScore ?? 0;
    return { week: label, efficiency: Math.round((score ?? 0) * 100) };
  });

  const dailyData = aggregateDailyCost(sessions.data ?? [], 30);
  const outcomeData = buildOutcomeData(costPerOutcome.data);
  const antiPatternSeries = buildAntiPatternSeries(weekly.data ?? []);

  return (
    <section>
      <h1 className="text-xl font-semibold mb-4">History</h1>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Weekly efficiency · last 8">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weeklyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} domain={[0, 100]} unit="%" />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="efficiency"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Daily spend · last 30 days">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #1e293b',
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="cost" fill={ACCENT} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Cost per outcome · last 30 days">
          {outcomeData.length === 0 ? (
            <EmptyState text="No outcomes yet — finish a few sessions and check back." />
          ) : (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={outcomeData} layout="vertical">
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis type="number" tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                  <YAxis
                    type="category"
                    dataKey="outcome"
                    tick={TICK_STYLE}
                    stroke={GRID_STROKE}
                    width={90}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="totalCost" fill={ACCENT} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Anti-pattern frequency · weekly">
          {antiPatternSeries.length === 0 ? (
            <EmptyState text="No anti-patterns detected in the loaded weeks." />
          ) : (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={antiPatternSeries}>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis dataKey="week" tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill={ACCENT_AMBER} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-3">
        <CoachCard data={coach.data} />
      </div>
    </section>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return <div className="text-ink-muted text-xs h-44 flex items-center">{text}</div>;
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
    const day = new Date(r.startTime).toISOString().slice(5, 10);
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

export function buildAntiPatternSeries(
  weeks: WeeklyRow[],
): Array<{ week: string; count: number }> {
  const out: Array<{ week: string; count: number }> = [];
  for (const w of weeks) {
    const counts = w.antiPatternCounts ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      out.push({ week: (w.weekStart ?? w.week ?? '').slice(5) || '?', count: total });
    }
  }
  return out;
}
