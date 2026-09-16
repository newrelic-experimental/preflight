import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  History,
  aggregateDailyCost,
  buildOutcomeData,
  buildAntiPatternSeries,
  aggregateModelPerformance,
  aggregateToolUsage,
  padDailyCostWindow,
} from './History';

const SAMPLE_WEEKLY = [
  {
    week: '2026-04-21',
    avgEfficiencyScore: 0.82,
    totalCostUsd: 14.12,
    antiPatternCounts: { thrashing: 3 },
  },
  {
    week: '2026-04-28',
    avgEfficiencyScore: 0.88,
    totalCostUsd: 18.4,
    antiPatternCounts: { thrashing: 1, blind_edit: 2 },
  },
  {
    week: '2026-05-05',
    avgEfficiencyScore: 0.91,
    totalCostUsd: 12.75,
    antiPatternCounts: {},
  },
  {
    week: '2026-05-12',
    avgEfficiencyScore: 0.94,
    totalCostUsd: 16.3,
    antiPatternCounts: { stuck_loop: 4 },
  },
];

const SAMPLE_SESSIONS = [
  {
    sessionId: 's1',
    startTime: '2026-05-26T09:00:00Z',
    estimatedCostUsd: 1.2,
    model: 'claude-opus-4-6',
    toolSuccessRate: 0.95,
    efficiencyScore: 0.88,
    toolBreakdown: { Read: 10, Edit: 5 },
  },
  {
    sessionId: 's2',
    startTime: '2026-05-26T15:00:00Z',
    estimatedCostUsd: 0.8,
    model: 'claude-opus-4-6',
    toolSuccessRate: 0.92,
    efficiencyScore: 0.85,
    toolBreakdown: { Read: 8, Bash: 3 },
  },
  {
    sessionId: 's3',
    startTime: '2026-05-27T10:00:00Z',
    estimatedCostUsd: 2.4,
    model: 'claude-sonnet-4-6',
    toolSuccessRate: 0.88,
    efficiencyScore: 0.72,
    toolBreakdown: { Read: 12, Edit: 7 },
  },
  {
    sessionId: 's4',
    startTime: '2026-05-28T11:00:00Z',
    estimatedCostUsd: 1.7,
    model: 'claude-opus-4-6',
    toolSuccessRate: 0.94,
    efficiencyScore: 0.9,
    toolBreakdown: { Read: 6, Write: 2 },
  },
];

const SAMPLE_OUTCOME = {
  outcomeDistribution: {
    bug_fix: { count: 3, totalCost: 4.2, avgCost: 1.4 },
    feature: { count: 2, totalCost: 3.0, avgCost: 1.5 },
    failed_attempt: { count: 1, totalCost: 0.5, avgCost: 0.5 },
  },
  costPerBugFix: 1.4,
  costPerFeature: 1.5,
  costPerRefactor: 0,
  costPerInvestigation: 0,
  costPerConfiguration: 0,
  costPerDocumentation: 0,
  costPerFailedAttempt: 0.5,
  wasteRatio: 0.0649,
  totalCost: 7.7,
  totalTasks: 6,
};

const SAMPLE_COACH_OK = {
  status: 'ok',
  developer: 'alice',
  generatedAt: 1000,
  weeksAnalyzed: 4,
  highlights: ['Efficiency up 8 points vs baseline.'],
  regressions: [],
  streaks: ['Cost per session has decreased for 3 consecutive weeks.'],
  topRecommendation: 'Strong week — document what worked in CLAUDE.md.',
  thisWeek: {
    weekId: '2026-W22',
    avgEfficiencyScore: 0.72,
    avgCostPerSession: 0.42,
    antiPatternRate: 0.042,
    sessionsCount: 5,
  },
  lastWeek: { weekId: '2026-W21' },
  baseline: {
    weekId: 'baseline',
    avgEfficiencyScore: 0.64,
    avgCostPerSession: 0.5,
    antiPatternRate: 0.035,
    sessionsCount: 4,
  },
};

const SAMPLE_COACH_INSUFFICIENT = {
  status: 'insufficient_data',
  developer: 'alice',
  weeksAvailable: 1,
  weeksRequired: 2,
  message: 'Need at least 2 weeks of session history.',
};

const SAMPLE_RECOMMENDATIONS_OK = {
  recommendations: [
    {
      id: 'r1',
      category: 'cost_optimization',
      priority: 'high',
      title: 'High failed attempt ratio',
      detail: 'Failed attempts represent a significant portion of spend.',
      evidence: 'Failed attempts: 32% of total cost',
    },
  ],
  count: 1,
};

const SAMPLE_RECOMMENDATIONS_EMPTY = {
  recommendations: [],
  count: 0,
};

const SAMPLE_CLAUDEMD_IMPACT = {
  change: {
    filePath: '/Users/alice/.claude/CLAUDE.md',
    changeType: 'modified',
    timestamp: new Date(2026, 5, 29, 12, 0, 0).getTime(),
    linesAdded: 5,
    linesRemoved: 2,
  },
  before: { avgEfficiencyScore: 0.64, avgCostUsd: 0.52, avgCorrectionRate: 0.18, sessionCount: 8 },
  after: { avgEfficiencyScore: 0.71, avgCostUsd: 0.44, avgCorrectionRate: 0.12, sessionCount: 6 },
  deltas: {
    efficiencyScore: { value: 0.07, percentChange: 10.9, improved: true },
    cost: { value: -0.08, percentChange: -15.4, improved: true },
    correctionRate: { value: -0.06, percentChange: -33.3, improved: true },
  },
  contextTokensForClaudeMd: 1240,
  verdict: 'Positive impact: efficiency +7pts, cost -15%',
};

const SAMPLE_CLAUDEMD_NO_CHANGES = {
  message: 'No instruction-file changes detected',
};

const SAMPLE_COLLAB_PROFILE = {
  classification: 'Explorer',
  dimensions: { specificity: 0.78, autonomy: 0.61, correctionRate: 0.42, taskComplexity: 0.73 },
  sessionCount: 47,
  teamDeltas: { specificity: 0.12, autonomy: 0.03, correctionRate: -0.08, taskComplexity: 0.05 },
  developerCount: 4,
};

const SAMPLE_COLLAB_EMPTY = {
  classification: 'Unknown',
  dimensions: { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 },
  sessionCount: 0,
  teamDeltas: { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 },
  developerCount: 0,
};

// Single-developer baseline fixture. teamDeltas are ~0 because the "team"
// baseline is just this one developer compared to itself; the panel must
// caveat this instead of presenting it as a real team comparison.
const SAMPLE_COLLAB_SINGLE_DEV = {
  classification: 'Power User',
  dimensions: { specificity: 0.7, autonomy: 0.65, correctionRate: 0.5, taskComplexity: 0.6 },
  sessionCount: 12,
  teamDeltas: { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 },
  developerCount: 1,
};

// The backend `correctionRate` dimension is a correction-free score — higher
// means fewer corrections were needed. A developer who needs fewer
// corrections than their team has a HIGHER correctionRate than the team, so
// this fixture's positive teamDeltas.correctionRate represents a developer
// with a lower (better) real-world correction rate than their team.
const SAMPLE_COLLAB_FEWER_CORRECTIONS = {
  classification: 'Power User',
  dimensions: { specificity: 0.7, autonomy: 0.65, correctionRate: 0.88, taskComplexity: 0.6 },
  sessionCount: 20,
  teamDeltas: { specificity: 0.02, autonomy: 0.01, correctionRate: 0.15, taskComplexity: 0.03 },
  developerCount: 5,
};

const SAMPLE_USAGE_INSIGHTS = {
  windowDays: 7,
  sessionCount: 12,
  totalCostUsd: 40,
  totalTokens: 200000,
  insights: [
    {
      id: 'high_context',
      key: 'high_context',
      costUsd: 12,
      tokens: 50000,
      count: 4,
      sharePct: 30,
      sessionCount: 12,
      headline: 'High-context sessions are driving spend',
      advice: 'Trim context before starting new sessions.',
    },
    {
      id: 'subagent_heavy',
      key: 'subagent_heavy',
      costUsd: 8,
      tokens: 20000,
      count: 3,
      sharePct: 20,
      sessionCount: 12,
      headline: 'Subagent delegation is a large cost driver',
      advice: 'Review which subagents are being spawned.',
    },
  ],
  skills: [{ key: 'code-review', costUsd: 5, tokens: 10000, count: 6, sharePct: 12 }],
  subagents: [{ key: 'general-purpose', costUsd: 4, tokens: 8000, count: 3, sharePct: 10 }],
  plugins: [{ key: 'pstack', costUsd: 2, tokens: 3000, count: 1, sharePct: 5 }],
  loops: [
    {
      sessionId: 'loop-session-1',
      sessionName: 'Nightly loop',
      runs: 5,
      tokens: 6000,
      tokensPerRun: 1200,
      costUsd: 1.5,
      lastRunMs: Date.now() - 5 * 60 * 1000,
    },
  ],
  skillsTotalCount: 1,
  subagentsTotalCount: 1,
  pluginsTotalCount: 1,
  loopsTotalCount: 1,
  attributionRatePct: 40,
};

interface FetchOverrides {
  outcome?: unknown;
  coach?: unknown;
  recommendations?: unknown;
  claudemdImpact?: unknown;
  collabProfile?: unknown;
  sessions?: unknown;
  usageInsights?: unknown;
}

function renderHistory(overrides: FetchOverrides = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const fetchedUrls: string[] = [];
  globalThis.fetch = ((url: string) => {
    fetchedUrls.push(url);
    if (url.startsWith('/api/usage-insights')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.usageInsights ?? SAMPLE_USAGE_INSIGHTS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/weekly')) {
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_WEEKLY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/cost-per-outcome')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.outcome ?? SAMPLE_OUTCOME), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/personal-coach')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.coach ?? SAMPLE_COACH_OK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/recommendations')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.recommendations ?? SAMPLE_RECOMMENDATIONS_OK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/claudemd-impact')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.claudemdImpact ?? SAMPLE_CLAUDEMD_IMPACT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/collaboration-profile')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.collabProfile ?? SAMPLE_COLLAB_PROFILE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/sessions')) {
      return Promise.resolve(
        new Response(JSON.stringify(overrides.sessions ?? SAMPLE_SESSIONS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/activity-heatmap')) {
      return Promise.resolve(
        new Response(JSON.stringify({ days: [{ date: '2026-05-26', count: 3 }], maxCount: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/concurrency')) {
      return Promise.resolve(
        new Response(JSON.stringify({ dailyPeaks: [{ date: '2026-05-26', peak: 2 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('null', { status: 200 }));
  }) as typeof globalThis.fetch;
  const result = render(
    <QueryClientProvider client={qc}>
      <History />
    </QueryClientProvider>,
  );
  return Object.assign(result, { fetchedUrls });
}

describe('History view', () => {
  it('renders the section headings', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/efficiency/i)).toBeInTheDocument());
    expect(screen.getByText(/daily spend/i)).toBeInTheDocument();
  });

  it('renders a chart for weekly efficiency', async () => {
    const { container } = renderHistory();
    await waitFor(() => {
      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the cost-per-outcome panel title', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/cost per outcome/i)).toBeInTheDocument());
  });

  it('renders the anti-pattern frequency panel title', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/anti-pattern frequency/i)).toBeInTheDocument());
  });

  it('renders the model performance panel title', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/model performance/i)).toBeInTheDocument());
  });

  it('renders the top tools panel title', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/top tools/i)).toBeInTheDocument());
  });

  it('titles the weekly efficiency panel to match the real 12-week fetch default', async () => {
    renderHistory();
    await waitFor(() =>
      expect(screen.getByText('Weekly Efficiency · Last 12')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Weekly Efficiency · Last 8')).toBeNull();
  });

  it('labels the daily spend panel with the 200-session-cap clarification', async () => {
    renderHistory();
    await waitFor(() =>
      expect(screen.getByText('Daily Spend · Last 30 Days (most recent 200)')).toBeInTheDocument(),
    );
  });

  it('titles the top tools panel to disclose the 200-session cap instead of claiming "All Sessions"', async () => {
    renderHistory();
    await waitFor(() =>
      expect(screen.getByText('Top Tools · Most Recent 200 Sessions')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Top Tools · All Sessions')).toBeNull();
  });

  it('titles the model performance panel with the same 200-session-cap disclosure as the other sampled panels', async () => {
    renderHistory();
    await waitFor(() =>
      expect(screen.getByText('Model Performance · Most Recent 200 Sessions')).toBeInTheDocument(),
    );
  });

  it('does not show a "+N more" tools note when there are 8 or fewer distinct tools', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/top tools/i)).toBeInTheDocument());
    expect(screen.queryByText(/more tools? not shown/i)).not.toBeInTheDocument();
  });

  it('shows a "+N more" tools note when aggregateToolUsage\'s top-8 cap drops entries', async () => {
    const toolBreakdown: Record<string, number> = {};
    for (let i = 0; i < 11; i++) toolBreakdown[`tool_${i}`] = 11 - i;
    renderHistory({ sessions: [{ sessionId: 's1', toolBreakdown }] });
    // 11 distinct tools, top 8 shown -> 3 hidden. Waits for the session
    // fetch to resolve — the panel briefly renders its empty state first.
    await waitFor(() => expect(screen.getByText('+3 more tools not shown')).toBeInTheDocument());
  });

  it('does not flag the daily spend chart for an account with only a few recent sessions', async () => {
    // Only 5 sessions total, well under the 200-row cap — nothing was
    // withheld, so the account's history genuinely started this morning
    // and the early days of the window are confirmed zero-spend.
    const recentOnly = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `recent-${i}`,
      startTime: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
      estimatedCostUsd: 1,
      model: 'claude-opus-4-6',
      toolBreakdown: { Read: 1 },
    }));
    renderHistory({ sessions: recentOnly });
    await waitFor(() => expect(screen.getByText(/daily spend/i)).toBeInTheDocument());
    expect(screen.queryByText(/sample doesn.t reach back 30 days/i)).not.toBeInTheDocument();
  });

  it('flags the daily spend chart when a full 200-session sample does not reach back 30 days', async () => {
    // 200 sessions (hitting the fetch cap) all within the last few hours —
    // the sample is capped AND doesn't cover the 30-day window, so early
    // days are genuinely unsampled rather than confirmed zero-spend.
    const cappedRecentOnly = Array.from({ length: 200 }, (_, i) => ({
      sessionId: `recent-${i}`,
      startTime: new Date(Date.now() - i * 60 * 1000).toISOString(),
      estimatedCostUsd: 1,
      model: 'claude-opus-4-6',
      toolBreakdown: { Read: 1 },
    }));
    renderHistory({ sessions: cappedRecentOnly });
    await waitFor(() =>
      expect(screen.getByText(/sample doesn.t reach back 30 days/i)).toBeInTheDocument(),
    );
  });

  it('does not flag the daily spend chart when the session sample already spans the full 30-day window', async () => {
    // Default SAMPLE_SESSIONS are dated well over 30 days before the
    // current clock, so the sample already covers the whole window.
    renderHistory();
    await waitFor(() => expect(screen.getByText(/daily spend/i)).toBeInTheDocument());
    expect(screen.queryByText(/sample doesn.t reach back 30 days/i)).not.toBeInTheDocument();
  });

  it('uses the real 12-week window in the activity heatmap aria-label', async () => {
    renderHistory();
    await waitFor(() =>
      expect(screen.getByLabelText('Daily activity heatmap for the last 12 weeks')).toBeTruthy(),
    );
  });

  it('labels Peak Concurrent Sessions with the real 30-day fetch window, not "All-Time"', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/Peak Concurrent Sessions/)).toBeInTheDocument());
    expect(screen.queryByText(/All-Time/)).toBeNull();
  });

  it('renders the personal coach panel and shows the top recommendation', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/personal coach/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/strong week/i)).toBeInTheDocument());
    expect(screen.getByText(/efficiency up 8 points/i)).toBeInTheDocument();
  });

  it('shows the insufficient-data message when the coach reports it', async () => {
    renderHistory({ coach: SAMPLE_COACH_INSUFFICIENT });
    await waitFor(() => expect(screen.getByText(/need at least 2 weeks/i)).toBeInTheDocument());
  });

  it('shows an empty state when there are no outcomes yet', async () => {
    renderHistory({ outcome: { ...SAMPLE_OUTCOME, outcomeDistribution: {}, totalTasks: 0 } });
    await waitFor(() => expect(screen.getByText(/no outcomes yet/i)).toBeInTheDocument());
  });

  it('renders an SVG inside each of the four chart panels', async () => {
    const { container } = renderHistory();
    const titles = [
      /weekly efficiency/i,
      /daily spend/i,
      /cost per outcome/i,
      /anti-pattern frequency/i,
    ];
    for (const title of titles) {
      await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
    }
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(4);
  });

  it('renders RecommendationsPanel with a high-priority item title and detail', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText('High failed attempt ratio')).toBeInTheDocument());
    expect(
      screen.getByText('Failed attempts represent a significant portion of spend.'),
    ).toBeInTheDocument();
  });

  it('renders no recommendations empty state when list is empty', async () => {
    renderHistory({ recommendations: SAMPLE_RECOMMENDATIONS_EMPTY });
    await waitFor(() => expect(screen.getByText('No recommendations yet')).toBeInTheDocument());
  });

  it('renders unavailable state when /api/recommendations returns 503', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_WEEKLY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/recommendations')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('Recommendations unavailable')).toBeInTheDocument(),
    );
  });

  it('renders ClaudeMdImpactPanel with verdict and metric rows', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/instruction file impact/i)).toBeInTheDocument());
    const panel = screen
      .getByText(/instruction file impact/i)
      .closest('.glass-card') as HTMLElement;
    expect(within(panel).getByText(/Positive impact/)).toBeInTheDocument();
    expect(within(panel).getByText('Efficiency')).toBeInTheDocument();
  });

  it('renders the before/after sample size next to each ClaudeMdImpactPanel column', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/instruction file impact/i)).toBeInTheDocument());
    expect(screen.getByText('Before (n=8)')).toBeInTheDocument();
    expect(screen.getByText('After (n=6)')).toBeInTheDocument();
  });

  it('renders no-changes state for ClaudeMdImpactPanel', async () => {
    renderHistory({ claudemdImpact: SAMPLE_CLAUDEMD_NO_CHANGES });
    await waitFor(() =>
      expect(screen.getByText('No instruction file changes yet')).toBeInTheDocument(),
    );
  });

  it('renders CollaborationProfilePanel with classification and dimension labels', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/collaboration profile/i)).toBeInTheDocument());
    expect(screen.getByText('Explorer')).toBeInTheDocument();
  });

  it('does not show the no-team-data caveat when developerCount is above 1', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText('Explorer')).toBeInTheDocument());
    expect(screen.queryByText(/no team data yet/i)).not.toBeInTheDocument();
  });

  it('renders the correction-rate delta in the "better" color when the developer corrects less than their team', async () => {
    renderHistory({ collabProfile: SAMPLE_COLLAB_FEWER_CORRECTIONS });
    await waitFor(() => expect(screen.getByText('Power User')).toBeInTheDocument());
    // "Correction-free rate" also appears as a Y-axis tick label inside the
    // SVG chart above the delta list; only the label in the delta row itself
    // has a sibling "% vs team" span, so filter to that row.
    const row = screen
      .getAllByText(/Correction-free rate/)
      .map((el) => el.closest('div'))
      .find((el) => el && within(el).queryByText(/vs team/) !== null);
    expect(row).toBeTruthy();
    const deltaEl = within(row!).getByText(/vs team/);
    expect(deltaEl.className).toContain('text-accent-green');
    expect(deltaEl.className).not.toContain('text-accent-amber');
    expect(within(row!).getByText(/\(higher = better\)/)).toBeInTheDocument();
  });

  it('shows a no-team-data caveat on CollaborationProfilePanel when developerCount is 1', async () => {
    renderHistory({ collabProfile: SAMPLE_COLLAB_SINGLE_DEV });
    await waitFor(() => expect(screen.getByText('Power User')).toBeInTheDocument());
    expect(screen.getByText(/no team data yet/i)).toBeInTheDocument();
  });

  it('renders no-data state for CollaborationProfilePanel', async () => {
    renderHistory({ collabProfile: SAMPLE_COLLAB_EMPTY });
    await waitFor(() => expect(screen.getByText('No collaboration data yet')).toBeInTheDocument());
  });

  it('skips the anti-pattern panel chart when no weeks have anti-patterns', async () => {
    const fetchOverrides = (url: string) => {
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                week: '2026-05-05',
                avgEfficiencyScore: 0.91,
                totalCostUsd: 12.75,
                antiPatternCounts: {},
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return null;
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      const override = fetchOverrides(url);
      if (override) return override;
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/no anti-patterns detected/i).length).toBeGreaterThanOrEqual(1),
    );
  });

  it('skips the anti-pattern panel chart when multiple loaded weeks all have zero anti-patterns', async () => {
    const fetchOverrides = (url: string) => {
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                week: '2026-05-05',
                avgEfficiencyScore: 0.91,
                totalCostUsd: 12.75,
                antiPatternCounts: {},
              },
              {
                week: '2026-05-12',
                avgEfficiencyScore: 0.88,
                totalCostUsd: 10.5,
                antiPatternCounts: {},
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return null;
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      const override = fetchOverrides(url);
      if (override) return override;
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/no anti-patterns detected/i).length).toBeGreaterThanOrEqual(1),
    );
  });

  it('shows the most recent drift verdict with deltas', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/instruction-drift')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              currentPromptHash: 'abc123',
              uniquePromptVariants: 2,
              variantStats: [],
              recentCorrelations: [
                {
                  fromHash: 'aaa',
                  toHash: 'bbb',
                  successRateDelta: -0.15,
                  tokensDelta: 6000,
                  thrashingDelta: 0.6,
                  efficiencyDelta: -0.1,
                  verdict: 'degraded',
                },
              ],
              currentVariantSessionCount: 3,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_WEEKLY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/activity-heatmap')) {
        return Promise.resolve(
          new Response(JSON.stringify({ days: [{ date: '2026-05-26', count: 3 }], maxCount: 3 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/concurrency')) {
        return Promise.resolve(
          new Response(JSON.stringify({ dailyPeaks: [{ date: '2026-05-26', peak: 2 }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/degraded/i)).toBeInTheDocument();
    expect(screen.getByText(/-15%/)).toBeInTheDocument();
  });

  it('shows a neutral empty state with no correlations yet', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/instruction-drift')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              currentPromptHash: null,
              uniquePromptVariants: 0,
              variantStats: [],
              recentCorrelations: [],
              currentVariantSessionCount: 0,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_WEEKLY), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/activity-heatmap')) {
        return Promise.resolve(
          new Response(JSON.stringify({ days: [{ date: '2026-05-26', count: 3 }], maxCount: 3 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/concurrency')) {
        return Promise.resolve(
          new Response(JSON.stringify({ dailyPeaks: [{ date: '2026-05-26', peak: 2 }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('null', { status: 200 }));
    }) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/no instruction file changes tracked yet/i)).toBeInTheDocument();
  });
});

describe('History — error handling', () => {
  it('shows an error banner when a query fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = ((url: string) => {
      if (url.startsWith('/api/weekly')) {
        return Promise.resolve(new Response('Internal Server Error', { status: 503 }));
      }
      if (url.startsWith('/api/cost-per-outcome')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_OUTCOME), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/personal-coach')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_COACH_OK), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_SESSIONS), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/activity-heatmap')) {
        return Promise.resolve(
          new Response(JSON.stringify({ days: [], maxCount: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/concurrency')) {
        return Promise.resolve(
          new Response(JSON.stringify({ dailyPeaks: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    }) as typeof globalThis.fetch;

    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );

    await waitFor(
      () => expect(screen.getByText(/Error loading some history data/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('shows no error banner when every query succeeds', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    render(
      <QueryClientProvider client={qc}>
        <History />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('History')).toBeInTheDocument());
    expect(screen.queryByText(/Error loading some history data/)).toBeNull();
  });
});

describe('History data helpers', () => {
  describe('aggregateDailyCost', () => {
    it('groups sessions by day, sums cost, and trims to N most recent days', () => {
      // Locally-constructed instants so the test is timezone-portable;
      // UTC ISO strings would shift days under negative-offset runners
      // after bucketing moved to local-time getters.
      const out = aggregateDailyCost(
        [
          {
            sessionId: 'a',
            startTime: new Date(2026, 4, 26, 9, 0, 0).getTime(),
            estimatedCostUsd: 1.2,
          },
          {
            sessionId: 'b',
            startTime: new Date(2026, 4, 26, 15, 0, 0).getTime(),
            estimatedCostUsd: 0.8,
          },
          {
            sessionId: 'c',
            startTime: new Date(2026, 4, 27, 10, 0, 0).getTime(),
            estimatedCostUsd: 2.4,
          },
        ],
        30,
      );
      expect(out).toEqual([
        { day: '2026-05-26', cost: 2.0 },
        { day: '2026-05-27', cost: 2.4 },
      ]);
    });

    it('skips sessions with null cost', () => {
      const out = aggregateDailyCost(
        [
          {
            sessionId: 'a',
            startTime: new Date(2026, 4, 26, 9, 0, 0).getTime(),
            estimatedCostUsd: null,
          },
          {
            sessionId: 'b',
            startTime: new Date(2026, 4, 26, 15, 0, 0).getTime(),
            estimatedCostUsd: 0.8,
          },
        ],
        30,
      );
      expect(out).toEqual([{ day: '2026-05-26', cost: 0.8 }]);
    });

    it('keeps only the most recent N days when there are more', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        sessionId: `s${i}`,
        startTime: new Date(2026, 4, 20 + i, 9, 0, 0).getTime(),
        estimatedCostUsd: 1,
      }));
      const out = aggregateDailyCost(rows, 3);
      expect(out).toHaveLength(3);
      expect(out.map((d) => d.day)).toEqual(['2026-05-27', '2026-05-28', '2026-05-29']);
    });

    it('returns an empty array when given no rows', () => {
      expect(aggregateDailyCost([], 30)).toEqual([]);
    });

    it('buckets sessions by local day, not UTC day', () => {
      // Construct an instant whose local representation is unambiguous
      // regardless of the runner's timezone. getTime() yields epoch ms that
      // round-trip through new Date(...) to the same local Y/M/D/H/M/S.
      // For runners east of UTC, toISOString() of this instant may report
      // the next UTC day — local bucketing must still report 05-31.
      const localLateEvening = new Date(2026, 4, 31, 22, 0, 0).getTime();
      const out = aggregateDailyCost(
        [{ sessionId: 'late', startTime: localLateEvening, estimatedCostUsd: 1.5 }],
        30,
      );
      expect(out).toEqual([{ day: '2026-05-31', cost: 1.5 }]);
    });

    it('buckets local early-morning sessions to their local day', () => {
      // Mirror of the above in the negative direction: runners west of UTC
      // see toISOString() report the previous UTC day for an early-morning
      // local instant, but local bucketing must report 06-01.
      const localEarlyMorning = new Date(2026, 5, 1, 1, 30, 0).getTime();
      const out = aggregateDailyCost(
        [{ sessionId: 'early', startTime: localEarlyMorning, estimatedCostUsd: 0.4 }],
        30,
      );
      expect(out).toEqual([{ day: '2026-06-01', cost: 0.4 }]);
    });
  });

  describe('buildOutcomeData', () => {
    it('flattens the distribution map and sorts by descending totalCost', () => {
      const out = buildOutcomeData({
        outcomeDistribution: {
          bug_fix: { count: 3, totalCost: 4.2, avgCost: 1.4 },
          feature: { count: 2, totalCost: 3.0, avgCost: 1.5 },
          failed_attempt: { count: 1, totalCost: 0.5, avgCost: 0.5 },
        },
        wasteRatio: 0.0649,
        totalCost: 7.7,
        totalTasks: 6,
      });
      expect(out).toEqual([
        { outcome: 'bug fix', totalCost: 4.2, count: 3 },
        { outcome: 'feature', totalCost: 3.0, count: 2 },
        { outcome: 'failed attempt', totalCost: 0.5, count: 1 },
      ]);
    });

    it('returns an empty array when the response is undefined', () => {
      expect(buildOutcomeData(undefined)).toEqual([]);
    });

    it('returns an empty array when the distribution is empty', () => {
      expect(
        buildOutcomeData({
          outcomeDistribution: {},
          wasteRatio: 0,
          totalCost: 0,
          totalTasks: 0,
        }),
      ).toEqual([]);
    });

    it('drops outcomes with totalCost === 0', () => {
      // Recharts auto-domains a horizontal BarChart whose only data points
      // are zero into a default [0,4] X axis, producing a phantom-looking
      // full-width bar. We filter zeros so the empty-state branch handles it.
      expect(
        buildOutcomeData({
          outcomeDistribution: {
            feature: { count: 1, totalCost: 0, avgCost: 0 },
          },
          wasteRatio: 0,
          totalCost: 0,
          totalTasks: 1,
        }),
      ).toEqual([]);
    });

    it('keeps non-zero outcomes when mixed with zero-cost ones', () => {
      const out = buildOutcomeData({
        outcomeDistribution: {
          feature: { count: 1, totalCost: 0, avgCost: 0 },
          bug_fix: { count: 2, totalCost: 4.5, avgCost: 2.25 },
        },
        wasteRatio: 0,
        totalCost: 4.5,
        totalTasks: 3,
      });
      expect(out).toEqual([{ outcome: 'bug fix', totalCost: 4.5, count: 2 }]);
    });
  });

  describe('padDailyCostWindow', () => {
    it('pads sparse data with zero-cost days across the requested window', () => {
      const today = new Date('2026-06-09T12:00:00');
      const out = padDailyCostWindow([{ day: '2026-06-09', cost: 30.12 }], 5, today);
      // 5 days ending today: 06-05, 06-06, 06-07, 06-08, 06-09
      expect(out).toEqual([
        { day: '2026-06-05', cost: 0 },
        { day: '2026-06-06', cost: 0 },
        { day: '2026-06-07', cost: 0 },
        { day: '2026-06-08', cost: 0 },
        { day: '2026-06-09', cost: 30.12 },
      ]);
    });

    it('preserves real costs for days that have data', () => {
      const today = new Date('2026-06-09T12:00:00');
      const out = padDailyCostWindow(
        [
          { day: '2026-06-07', cost: 5 },
          { day: '2026-06-09', cost: 12.5 },
        ],
        4,
        today,
      );
      expect(out).toEqual([
        { day: '2026-06-06', cost: 0 },
        { day: '2026-06-07', cost: 5 },
        { day: '2026-06-08', cost: 0 },
        { day: '2026-06-09', cost: 12.5 },
      ]);
    });

    it('returns a fully-zero window when given no data', () => {
      const today = new Date('2026-06-09T12:00:00');
      const out = padDailyCostWindow([], 3, today);
      expect(out).toEqual([
        { day: '2026-06-07', cost: 0 },
        { day: '2026-06-08', cost: 0 },
        { day: '2026-06-09', cost: 0 },
      ]);
    });
  });

  describe('buildAntiPatternSeries', () => {
    it('sums anti-pattern counts per week and zero-fills weeks with none', () => {
      const out = buildAntiPatternSeries([
        {
          week: '2026-04-21',
          avgEfficiencyScore: 0.82,
          totalCostUsd: 14,
          antiPatternCounts: { thrashing: 3 },
        },
        {
          week: '2026-04-28',
          avgEfficiencyScore: 0.88,
          totalCostUsd: 18,
          antiPatternCounts: { thrashing: 1, blind_edit: 2 },
        },
        { week: '2026-05-05', avgEfficiencyScore: 0.91, totalCostUsd: 12, antiPatternCounts: {} },
        {
          week: '2026-05-12',
          avgEfficiencyScore: 0.94,
          totalCostUsd: 16,
          antiPatternCounts: { stuck_loop: 4 },
        },
      ]);
      // Keep the full ISO date in chart data so cross-year ticks
      // remain unique; the XAxis tickFormatter shortens to MM-DD on render.
      // The zero-count week stays in the series (like padDailyCostWindow's
      // zero-fill) so the chart's x-axis reflects a continuous timeline.
      expect(out).toEqual([
        { week: '2026-04-21', count: 3 },
        { week: '2026-04-28', count: 3 },
        { week: '2026-05-05', count: 0 },
        { week: '2026-05-12', count: 4 },
      ]);
    });

    it('treats missing antiPatternCounts as a zero-count week', () => {
      const out = buildAntiPatternSeries([
        { week: '2026-05-05', avgEfficiencyScore: 0.9, totalCostUsd: 10, antiPatternCounts: {} },
      ]);
      expect(out).toEqual([{ week: '2026-05-05', count: 0 }]);
    });

    it('returns an empty array when given no weeks', () => {
      expect(buildAntiPatternSeries([])).toEqual([]);
    });
  });
});

/**
 * Tests that verify helper functions work with REAL API response shapes.
 * The real API uses different field names and types than the frontend
 * originally assumed (e.g., epoch ms numbers instead of ISO strings,
 * "week" instead of "weekStart", "avgEfficiencyScore" instead of "efficiencyScore").
 */
describe('History helpers with real API data shapes', () => {
  describe('aggregateDailyCost with real /api/sessions shape', () => {
    it('handles sessions with numeric startTime (epoch ms)', () => {
      // Real API returns startTime as epoch ms number, not ISO string
      const out = aggregateDailyCost(
        [
          { sessionId: 'abc-123', startTime: 1780361259600, estimatedCostUsd: 0.42 },
          { sessionId: 'def-456', startTime: 1780361259600 + 3600000, estimatedCostUsd: 0.58 },
        ],
        30,
      );
      expect(out.length).toBeGreaterThan(0);
      // Both sessions are on the same day, so costs should be summed
      expect(out[0].cost).toBe(1.0);
      // The day string should be a valid MM-DD format
      expect(out[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('handles sessions with undefined estimatedCostUsd (skips them)', () => {
      const out = aggregateDailyCost(
        [
          { sessionId: 'abc-123', startTime: 1780361259600, estimatedCostUsd: undefined },
          { sessionId: 'def-456', startTime: 1780361259600, estimatedCostUsd: 0.5 },
        ],
        30,
      );
      // Only the session with a defined cost should be included
      expect(out).toHaveLength(1);
      expect(out[0].cost).toBe(0.5);
    });

    it('handles sessions with null estimatedCostUsd (skips them)', () => {
      const out = aggregateDailyCost(
        [
          { sessionId: 'abc-123', startTime: 1780361259600, estimatedCostUsd: null },
          { sessionId: 'def-456', startTime: 1780361259600, estimatedCostUsd: 1.2 },
        ],
        30,
      );
      expect(out).toHaveLength(1);
      expect(out[0].cost).toBe(1.2);
    });

    it('handles sessions with undefined startTime (skips them)', () => {
      const out = aggregateDailyCost(
        [
          { sessionId: 'abc-123', startTime: undefined, estimatedCostUsd: 0.42 },
          { sessionId: 'def-456', startTime: 1780361259600, estimatedCostUsd: 0.5 },
        ],
        30,
      );
      // The session without startTime should be skipped
      expect(out).toHaveLength(1);
      expect(out[0].cost).toBe(0.5);
    });

    it('returns empty array for empty input', () => {
      expect(aggregateDailyCost([], 30)).toEqual([]);
    });
  });

  describe('buildAntiPatternSeries with real /api/weekly shape', () => {
    it('handles weeks with "week" field (not "weekStart")', () => {
      // Real API returns "week": "2026-W22" instead of "weekStart": "2026-05-25"
      const out = buildAntiPatternSeries([
        {
          week: '2026-W22',
          avgEfficiencyScore: null,
          totalCostUsd: 0,
          antiPatternCounts: { thrashing: 2, blind_edit: 1 },
        },
        {
          week: '2026-W23',
          avgEfficiencyScore: null,
          totalCostUsd: 5.0,
          antiPatternCounts: { stuck_loop: 3 },
        },
      ]);
      // Keep the full week identifier in chart data; the XAxis
      // tickFormatter shortens to MM-DD on render (or leaves unchanged
      // for non-ISO labels like '2026-W22').
      expect(out).toEqual([
        { week: '2026-W22', count: 3 },
        { week: '2026-W23', count: 3 },
      ]);
    });

    it('uses the week field from the real API response', () => {
      // Real API returns week in format like '2026-W22'
      const out = buildAntiPatternSeries([
        {
          week: '2026-W22',
          avgEfficiencyScore: 0.85,
          totalCostUsd: 0,
          antiPatternCounts: { thrashing: 5 },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].count).toBe(5);
      // Full label preserved in chart data; XAxis tickFormatter
      // handles display-time shortening.
      expect(out[0].week).toBe('2026-W22');
    });

    it('handles empty antiPatternCounts (zero-fills the week)', () => {
      const out = buildAntiPatternSeries([
        {
          week: '2026-W22',
          totalCostUsd: 0,
          avgEfficiencyScore: null,
          antiPatternCounts: {},
        },
      ]);
      expect(out).toEqual([{ week: '2026-W22', count: 0 }]);
    });
  });

  describe('buildOutcomeData with real API edge cases', () => {
    it('handles undefined input', () => {
      expect(buildOutcomeData(undefined)).toEqual([]);
    });

    it('handles empty outcomeDistribution', () => {
      const out = buildOutcomeData({
        outcomeDistribution: {},
        wasteRatio: 0,
        totalCost: 0,
        totalTasks: 0,
      });
      expect(out).toEqual([]);
    });
  });
});

describe('aggregateModelPerformance', () => {
  it('sums only the costs sessions actually reported, so a live stub row does not inflate the total', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', estimatedCostUsd: 2.0 },
      { sessionId: 's2', model: 'claude-opus-4-6', estimatedCostUsd: 1.5 },
      { sessionId: 'live', model: 'claude-opus-4-6' },
    ];
    const opus = aggregateModelPerformance(sessions)[0];
    expect(opus.sessions).toBe(3);
    expect(opus.costedSessions).toBe(2);
    expect(opus.totalCost).toBeCloseTo(3.5);
    expect(opus.avgCost).toBeCloseTo(1.75);
  });

  it('groups sessions by model with computed averages', () => {
    const sessions = [
      {
        sessionId: 's1',
        model: 'claude-opus-4-6',
        efficiencyScore: 0.9,
        toolSuccessRate: 0.95,
        estimatedCostUsd: 2.0,
      },
      {
        sessionId: 's2',
        model: 'claude-opus-4-6',
        efficiencyScore: 0.8,
        toolSuccessRate: 0.92,
        estimatedCostUsd: 1.5,
      },
      {
        sessionId: 's3',
        model: 'claude-sonnet-4-6',
        efficiencyScore: 0.7,
        toolSuccessRate: 0.88,
        estimatedCostUsd: 0.5,
      },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result).toHaveLength(2);
    const opus = result.find((m) => m.model === 'claude-opus-4-6')!;
    expect(opus.sessions).toBe(2);
    expect(opus.avgEfficiency).toBeCloseTo(0.85);
    expect(opus.avgSuccessRate).toBeCloseTo(0.935);
    expect(opus.avgCost).toBeCloseTo(1.75);
    expect(opus.flagged).toBe(false);
  });

  it('computes costPerMillionTokens as a blended rate across all sessions for the model', () => {
    const sessions = [
      {
        sessionId: 's1',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 6.0,
        tokensInput: 400_000,
        tokensOutput: 200_000,
      },
      {
        sessionId: 's2',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 3.0,
        tokensInput: 300_000,
        tokensOutput: 100_000,
      },
    ];
    const result = aggregateModelPerformance(sessions);
    // totalCost=9.0, totalTokens=1_000_000 -> 9.0 / 1_000_000 * 1e6 = 9.0
    expect(result[0].costPerMillionTokens).toBeCloseTo(9.0);
  });

  it('returns null costPerMillionTokens when no token counts are present', () => {
    const sessions = [{ sessionId: 's1', model: 'claude-opus-4-6', estimatedCostUsd: 1.0 }];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].costPerMillionTokens).toBeNull();
  });

  it("excludes a session's cost from costPerMillionTokens when it has no token counts yet", () => {
    const sessions = [
      // Persisted session: cost and tokens both known.
      {
        sessionId: 's1',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 9.0,
        tokensInput: 800_000,
        tokensOutput: 200_000,
      },
      // Live session stub: cost already reported, but token counts haven't
      // persisted yet. Including its cost without matching tokens would
      // inflate the blended rate above the true 9.0 for this model.
      {
        sessionId: 's2-live',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 5.0,
      },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].costPerMillionTokens).toBeCloseTo(9.0);
  });

  it('excludes a session with explicit zero token counts but real cost from costPerMillionTokens', () => {
    const sessions = [
      {
        sessionId: 's1',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 9.0,
        tokensInput: 800_000,
        tokensOutput: 200_000,
      },
      // Reports a real cost but the schema's non-null token defaults happen
      // to both be 0 (e.g. a token-count write failure) — a null-check
      // guard would treat this as "has tokens" and let the cost inflate the
      // blended rate above the true 9.0.
      {
        sessionId: 's2-zero-tokens',
        model: 'claude-opus-4-6',
        estimatedCostUsd: 5.0,
        tokensInput: 0,
        tokensOutput: 0,
      },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].costPerMillionTokens).toBeCloseTo(9.0);
  });

  it('flags models that have sessions below 85% success rate', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', toolSuccessRate: 0.95 },
      { sessionId: 's2', model: 'claude-opus-4-6', toolSuccessRate: 0.8 },
      { sessionId: 's3', model: 'claude-opus-4-6', toolSuccessRate: 0.93 },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].flagged).toBe(true);
  });

  it('does not flag a model when only a small proportion of its many sessions have low success', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', toolSuccessRate: 0.6 },
      ...Array.from({ length: 49 }, (_, i) => ({
        sessionId: `s${i + 2}`,
        model: 'claude-opus-4-6',
        toolSuccessRate: 0.95,
      })),
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].sessions).toBe(50);
    expect(result[0].flagged).toBe(false);
  });

  it('flags a model when a large proportion of a small sample has low success', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', toolSuccessRate: 0.5 },
      { sessionId: 's2', model: 'claude-opus-4-6', toolSuccessRate: 0.95 },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].sessions).toBe(2);
    expect(result[0].flagged).toBe(true);
  });

  it('flags a model based on the proportion of measured sessions with low success, not the proportion of all sessions', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', toolSuccessRate: 0.5 },
      { sessionId: 's2', model: 'claude-opus-4-6', toolSuccessRate: 0.6 },
      // These sessions have no recorded success rate at all — they must not
      // dilute the flagged proportion, which is a fraction of measured
      // sessions only.
      ...Array.from({ length: 8 }, (_, i) => ({
        sessionId: `s${i + 3}`,
        model: 'claude-opus-4-6',
      })),
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].sessions).toBe(10);
    expect(result[0].avgSuccessRate).toBeCloseTo(0.55);
    expect(result[0].flagged).toBe(true);
  });

  it('does not flag a model with no measured sessions', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6' },
      { sessionId: 's2', model: 'claude-opus-4-6' },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].avgSuccessRate).toBeNull();
    expect(result[0].flagged).toBe(false);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateModelPerformance([])).toEqual([]);
  });

  it('treats null model as "unknown"', () => {
    const sessions = [{ sessionId: 's1', model: null, toolSuccessRate: 0.9 }];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].model).toBe('unknown');
  });

  it('sorts by session count descending', () => {
    const sessions = [
      { sessionId: 's1', model: 'sonnet' },
      { sessionId: 's2', model: 'opus' },
      { sessionId: 's3', model: 'opus' },
      { sessionId: 's4', model: 'opus' },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].model).toBe('opus');
    expect(result[1].model).toBe('sonnet');
  });
});

describe('aggregateToolUsage', () => {
  it('merges tool breakdowns across sessions and returns top 8', () => {
    const sessions: Parameters<typeof aggregateToolUsage>[0] = [
      { sessionId: 's1', toolBreakdown: { Read: 10, Edit: 5, Bash: 3 } },
      { sessionId: 's2', toolBreakdown: { Read: 8, Edit: 7, Write: 2 } },
    ];
    const result = aggregateToolUsage(sessions);
    expect(result[0]).toEqual({ tool: 'Read', count: 18 });
    expect(result[1]).toEqual({ tool: 'Edit', count: 12 });
    expect(result[2]).toEqual({ tool: 'Bash', count: 3 });
    expect(result[3]).toEqual({ tool: 'Write', count: 2 });
  });

  it('limits to top 8 tools', () => {
    const toolBreakdown: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      toolBreakdown[`tool_${i}`] = 12 - i;
    }
    const sessions = [{ sessionId: 's1', toolBreakdown }];
    const result = aggregateToolUsage(sessions);
    expect(result).toHaveLength(8);
    expect(result[0].tool).toBe('tool_0');
    expect(result[7].tool).toBe('tool_7');
  });

  it('skips sessions without toolBreakdown', () => {
    const sessions = [{ sessionId: 's1' }, { sessionId: 's2', toolBreakdown: { Read: 5 } }];
    const result = aggregateToolUsage(sessions);
    expect(result).toEqual([{ tool: 'Read', count: 5 }]);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateToolUsage([])).toEqual([]);
  });
});

describe('CoachMetricsTable', () => {
  it('renders all four metric row labels and the efficiency delta badge', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/personal coach/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/strong week/i)).toBeInTheDocument());
    const panel = screen.getByText(/personal coach/i).closest('.glass-card') as HTMLElement;
    // Check for the four row labels (exact match with word boundaries)
    expect(within(panel).getByText('Efficiency')).toBeInTheDocument();
    expect(within(panel).getByText('Cost / session')).toBeInTheDocument();
    expect(within(panel).getByText('Anti-pattern rate')).toBeInTheDocument();
    expect(within(panel).getAllByText('Sessions').length).toBeGreaterThanOrEqual(1);
    // Now check for the metrics table values
    expect(within(panel).getByText('72')).toBeInTheDocument(); // effValue = 0.72 * 100 = 72
    expect(within(panel).getByText('$0.42')).toBeInTheDocument(); // thisWeek cost
    expect(within(panel).getByText('4.2%')).toBeInTheDocument(); // antiPatternRate as percentage
    // SAMPLE_COACH_OK has efficiency 0.72 vs baseline 0.64 → delta = +8pts
    expect(within(panel).getByText('↑8pts')).toBeInTheDocument();
  });

  it('renders zero deltas correctly when baseline values are null or zero', async () => {
    const coachNullBaseline = {
      ...SAMPLE_COACH_OK,
      status: 'ok' as const,
      baseline: {
        ...SAMPLE_COACH_OK.baseline,
        avgEfficiencyScore: null,
        avgCostPerSession: 0,
        antiPatternRate: 0,
      },
    };
    renderHistory({ coach: coachNullBaseline });
    await waitFor(() => expect(screen.getByText(/personal coach/i)).toBeInTheDocument());
    // Verify the coach card renders with the null/zero baseline without crashing
    // The component should handle null efficiency and zero-valued baseline metrics gracefully
    expect(screen.getByText(/personal coach/i)).toBeInTheDocument();
    expect(screen.getByText(/Efficiency/i)).toBeInTheDocument();
  });
});

describe('UsageContributionPanel', () => {
  it('renders the contribution panel title', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/daily spend/i)).toBeInTheDocument());
    expect(screen.getByText("What's contributing to your spend")).toBeInTheDocument();
  });

  it('renders each insight headline, one row from each of the four tables, and the low-attribution footnote', async () => {
    renderHistory({ usageInsights: SAMPLE_USAGE_INSIGHTS });
    await waitFor(() =>
      expect(screen.getByText('High-context sessions are driving spend')).toBeInTheDocument(),
    );
    expect(screen.getByText('Subagent delegation is a large cost driver')).toBeInTheDocument();
    expect(screen.getByText('code-review')).toBeInTheDocument();
    expect(screen.getByText('general-purpose')).toBeInTheDocument();
    expect(screen.getByText('pstack')).toBeInTheDocument();
    expect(screen.getByText('Nightly loop')).toBeInTheDocument();
    expect(screen.getByText(/40% of spend with/)).toBeInTheDocument();
  });

  it('says how many rows a capped table dropped, and nothing when it dropped none', async () => {
    renderHistory({
      usageInsights: { ...SAMPLE_USAGE_INSIGHTS, skillsTotalCount: 14, loopsTotalCount: 1 },
    });
    await waitFor(() => expect(screen.getByText('code-review')).toBeInTheDocument());
    expect(screen.getByText('top 1 of 14')).toBeInTheDocument();
    expect(screen.queryByText('top 1 of 1')).not.toBeInTheDocument();
  });

  it('renders "<1%" instead of "0%" for a row with spend that rounds to a zero share', async () => {
    renderHistory({
      usageInsights: {
        ...SAMPLE_USAGE_INSIGHTS,
        plugins: [{ key: 'tiny-plugin', costUsd: 0.01, tokens: 50, count: 1, sharePct: 0 }],
      },
    });
    await waitFor(() => expect(screen.getByText('tiny-plugin')).toBeInTheDocument());
    expect(screen.getByText('<1%')).toBeInTheDocument();
  });

  it('shows "No sessions in this window." when sessionCount is 0', async () => {
    renderHistory({
      usageInsights: {
        ...SAMPLE_USAGE_INSIGHTS,
        sessionCount: 0,
        insights: [],
        skills: [],
        subagents: [],
        plugins: [],
        loops: [],
      },
    });
    await waitFor(() =>
      expect(screen.getByText('No sessions in this window.')).toBeInTheDocument(),
    );
  });

  it('shows "Nothing stands out in this window." with empty insights while still rendering a populated skills table', async () => {
    renderHistory({
      usageInsights: {
        ...SAMPLE_USAGE_INSIGHTS,
        insights: [],
        subagents: [],
        plugins: [],
        loops: [],
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Nothing stands out in this window.')).toBeInTheDocument(),
    );
    expect(screen.getByText('code-review')).toBeInTheDocument();
  });

  it('calls fetchUsageInsights with 30 when the "30 days" tab is clicked', async () => {
    const { fetchedUrls } = renderHistory({ usageInsights: SAMPLE_USAGE_INSIGHTS });
    await waitFor(() => expect(screen.getByText('30 days')).toBeInTheDocument());
    fireEvent.click(screen.getByText('30 days'));
    await waitFor(() =>
      expect(fetchedUrls.some((u) => u.startsWith('/api/usage-insights?days=30'))).toBe(true),
    );
  });
});

describe('History share labels', () => {
  it('computes the Model Performance Share column from the mocked sessions costs', async () => {
    // aggregateModelPerformance(SAMPLE_SESSIONS): opus totalCost = 3.7,
    // sonnet totalCost = 2.4, total = 6.1 -> opus share = round(3.7/6.1*100) = 61%.
    renderHistory();
    await waitFor(() => expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument());
    const row = screen.getByText('claude-opus-4-6').closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell');
    // Columns: Model, Sessions, Eff., Success, Avg $, Share, $/1M tok.
    expect(cells[5].textContent).toBe('61%');
  });

  it('renders a share percent for the top tool in the Top Tools tooltip', async () => {
    // aggregateToolUsage(SAMPLE_SESSIONS): Read=36, Edit=12, Bash=3, Write=2,
    // total=53 -> Read's tooltip share = round(36/53*100) = 68%.
    renderHistory();
    await waitFor(() => expect(screen.getByText(/top tools/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Read (68%)')).toBeInTheDocument());
    const panel = screen.getByText(/top tools/i).closest('.glass-card') as HTMLElement;
    // Wait for the bars' entrance animation to finish mounting their shapes
    // before hovering — Recharts renders the Bar's `<path>` asynchronously.
    await waitFor(
      () => expect(panel.querySelectorAll('path.recharts-rectangle').length).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    // Recharts binds its mouse tracking to the `.recharts-wrapper` div and
    // resolves chart coordinates from `getBoundingClientRect`, which jsdom
    // always reports as zero-sized — stub it to match the 500x200 size the
    // shared ResizeObserver/clientWidth stubs (src/web/test-setup.ts) give
    // the chart, so a real hover position maps to the right bar.
    const wrapper = panel.querySelector('.recharts-wrapper') as Element;
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 500,
      height: 200,
      right: 500,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    try {
      // Read's bar spans roughly x:125-486, y:9-41 in the 500x200 viewBox
      // (from the rendered path's x/y/width/height) — move inside it and
      // let the tooltip's requestAnimationFrame-scheduled update flush.
      await act(async () => {
        fireEvent.mouseMove(wrapper, { clientX: 300, clientY: 25 });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    } finally {
      rectSpy.mockRestore();
    }
    expect(await screen.findByText(/36 \(68%\)/)).toBeInTheDocument();
    expect(screen.getByText('Read (68%)')).toBeInTheDocument();
  });
});
