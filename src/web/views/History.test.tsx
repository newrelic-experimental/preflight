import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  History,
  aggregateDailyCost,
  buildOutcomeData,
  buildAntiPatternSeries,
} from './History';

const SAMPLE_WEEKLY = [
  {
    weekStart: '2026-04-21',
    efficiencyScore: 0.82,
    totalCostUsd: 14.12,
    antiPatternCounts: { thrashing: 3 },
  },
  {
    weekStart: '2026-04-28',
    efficiencyScore: 0.88,
    totalCostUsd: 18.4,
    antiPatternCounts: { thrashing: 1, blind_edit: 2 },
  },
  {
    weekStart: '2026-05-05',
    efficiencyScore: 0.91,
    totalCostUsd: 12.75,
    antiPatternCounts: {},
  },
  {
    weekStart: '2026-05-12',
    efficiencyScore: 0.94,
    totalCostUsd: 16.3,
    antiPatternCounts: { stuck_loop: 4 },
  },
];

const SAMPLE_SESSIONS = [
  { sessionId: 's1', startTime: '2026-05-26T09:00:00Z', estimatedCostUsd: 1.2 },
  { sessionId: 's2', startTime: '2026-05-26T15:00:00Z', estimatedCostUsd: 0.8 },
  { sessionId: 's3', startTime: '2026-05-27T10:00:00Z', estimatedCostUsd: 2.4 },
  { sessionId: 's4', startTime: '2026-05-28T11:00:00Z', estimatedCostUsd: 1.7 },
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

  it('renders the personal coach panel and shows the top recommendation', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/personal coach/i)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText(/strong week/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/efficiency up 8 points/i)).toBeInTheDocument();
  });

  it('shows the insufficient-data message when the coach reports it', async () => {
    renderHistory({ coach: SAMPLE_COACH_INSUFFICIENT });
    await waitFor(() =>
      expect(screen.getByText(/need at least 2 weeks/i)).toBeInTheDocument(),
    );
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
              { weekStart: '2026-05-05', efficiencyScore: 0.91, totalCostUsd: 12.75, antiPatternCounts: {} },
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
      expect(screen.getByText(/no anti-patterns detected/i)).toBeInTheDocument(),
    );
  });
});

describe('History data helpers', () => {
  describe('aggregateDailyCost', () => {
    it('groups sessions by day, sums cost, and trims to N most recent days', () => {
      const out = aggregateDailyCost(
        [
          { sessionId: 'a', startTime: '2026-05-26T09:00:00Z', estimatedCostUsd: 1.2 },
          { sessionId: 'b', startTime: '2026-05-26T15:00:00Z', estimatedCostUsd: 0.8 },
          { sessionId: 'c', startTime: '2026-05-27T10:00:00Z', estimatedCostUsd: 2.4 },
        ],
        30,
      );
      expect(out).toEqual([
        { day: '05-26', cost: 2.0 },
        { day: '05-27', cost: 2.4 },
      ]);
    });

    it('skips sessions with null cost', () => {
      const out = aggregateDailyCost(
        [
          { sessionId: 'a', startTime: '2026-05-26T09:00:00Z', estimatedCostUsd: null },
          { sessionId: 'b', startTime: '2026-05-26T15:00:00Z', estimatedCostUsd: 0.8 },
        ],
        30,
      );
      expect(out).toEqual([{ day: '05-26', cost: 0.8 }]);
    });

    it('keeps only the most recent N days when there are more', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        sessionId: `s${i}`,
        startTime: `2026-05-${String(20 + i).padStart(2, '0')}T09:00:00Z`,
        estimatedCostUsd: 1,
      }));
      const out = aggregateDailyCost(rows, 3);
      expect(out).toHaveLength(3);
      expect(out.map((d) => d.day)).toEqual(['05-27', '05-28', '05-29']);
    });

    it('returns an empty array when given no rows', () => {
      expect(aggregateDailyCost([], 30)).toEqual([]);
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
  });

  describe('buildAntiPatternSeries', () => {
    it('sums anti-pattern counts per week and skips weeks with zero', () => {
      const out = buildAntiPatternSeries([
        { weekStart: '2026-04-21', efficiencyScore: 0.82, totalCostUsd: 14, antiPatternCounts: { thrashing: 3 } },
        { weekStart: '2026-04-28', efficiencyScore: 0.88, totalCostUsd: 18, antiPatternCounts: { thrashing: 1, blind_edit: 2 } },
        { weekStart: '2026-05-05', efficiencyScore: 0.91, totalCostUsd: 12, antiPatternCounts: {} },
        { weekStart: '2026-05-12', efficiencyScore: 0.94, totalCostUsd: 16, antiPatternCounts: { stuck_loop: 4 } },
      ]);
      expect(out).toEqual([
        { week: '04-21', count: 3 },
        { week: '04-28', count: 3 },
        { week: '05-12', count: 4 },
      ]);
    });

    it('treats missing antiPatternCounts as empty', () => {
      const out = buildAntiPatternSeries([
        { weekStart: '2026-05-05', efficiencyScore: 0.9, totalCostUsd: 10 },
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
      expect(out[0].day).toMatch(/^\d{2}-\d{2}$/);
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
          totalCostUsd: 0,
          antiPatternCounts: { thrashing: 2, blind_edit: 1 },
        },
        {
          week: '2026-W23',
          totalCostUsd: 5.0,
          antiPatternCounts: { stuck_loop: 3 },
        },
      ]);
      expect(out).toEqual([
        { week: 'W22', count: 3 },
        { week: 'W23', count: 3 },
      ]);
    });

    it('handles weeks where weekStart is undefined (falls back to week field)', () => {
      // weekStart is undefined, but week is present -- should use week
      const out = buildAntiPatternSeries([
        {
          weekStart: undefined,
          week: '2026-W22',
          totalCostUsd: 0,
          antiPatternCounts: { thrashing: 5 },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].count).toBe(5);
      // Should slice from index 5 of "2026-W22" -> "W22"... actually let's check
      // (w.weekStart ?? w.week ?? '').slice(5) -- weekStart is undefined so ?? picks week
      // "2026-W22".slice(5) -> "W22"
      expect(out[0].week).toBe('W22');
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
