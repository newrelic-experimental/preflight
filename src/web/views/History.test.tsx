import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  thisWeek: { weekId: '2026-W22' },
  lastWeek: { weekId: '2026-W21' },
  baseline: { weekId: 'baseline' },
};

const SAMPLE_COACH_INSUFFICIENT = {
  status: 'insufficient_data',
  developer: 'alice',
  weeksAvailable: 1,
  weeksRequired: 2,
  message: 'Need at least 2 weeks of session history.',
};

interface FetchOverrides {
  outcome?: unknown;
  coach?: unknown;
}

function renderHistory(overrides: FetchOverrides = {}) {
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
  return render(
    <QueryClientProvider client={qc}>
      <History />
    </QueryClientProvider>,
  );
}

describe('History view', () => {
  it('renders the section headings', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/efficiency/i)).toBeInTheDocument());
    expect(screen.getByText(/spend/i)).toBeInTheDocument();
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
      // after the F-026 fix moved bucketing to local-time getters.
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
    it('sums anti-pattern counts per week and skips weeks with zero', () => {
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
      // F-040: keep the full ISO date in chart data so cross-year ticks
      // remain unique; the XAxis tickFormatter shortens to MM-DD on render.
      expect(out).toEqual([
        { week: '2026-04-21', count: 3 },
        { week: '2026-04-28', count: 3 },
        { week: '2026-05-12', count: 4 },
      ]);
    });

    it('treats missing antiPatternCounts as empty', () => {
      const out = buildAntiPatternSeries([
        { week: '2026-05-05', avgEfficiencyScore: 0.9, totalCostUsd: 10, antiPatternCounts: {} },
      ]);
      expect(out).toEqual([]);
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
      // F-040: keep the full week identifier in chart data; the XAxis
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
      // F-040: full label preserved in chart data; XAxis tickFormatter
      // handles display-time shortening.
      expect(out[0].week).toBe('2026-W22');
    });

    it('handles empty antiPatternCounts (skips the week)', () => {
      const out = buildAntiPatternSeries([
        {
          week: '2026-W22',
          totalCostUsd: 0,
          avgEfficiencyScore: null,
          antiPatternCounts: {},
        },
      ]);
      expect(out).toEqual([]);
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

  it('flags models that have sessions below 85% success rate', () => {
    const sessions = [
      { sessionId: 's1', model: 'claude-opus-4-6', toolSuccessRate: 0.95 },
      { sessionId: 's2', model: 'claude-opus-4-6', toolSuccessRate: 0.8 },
      { sessionId: 's3', model: 'claude-opus-4-6', toolSuccessRate: 0.93 },
    ];
    const result = aggregateModelPerformance(sessions);
    expect(result[0].flagged).toBe(true);
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
    const sessions = [
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
