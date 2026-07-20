import { PersonalCoach } from './personal-coach.js';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import type { WeeklySummary } from '../storage/weekly-summary.js';

// Suppress logger output
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

function makeWeeklyStats(
  overrides: Partial<{
    sessionCount: number;
    totalCostUsd: number;
    avgEfficiencyScore: number | null;
    totalToolCalls: number;
    totalTasksCompleted: number;
    taskSuccessRate: number | null;
    toolBreakdown: Record<string, number>;
    antiPatternCounts: Record<string, number>;
  }> = {},
) {
  return {
    sessionCount: 10,
    totalCostUsd: 5.0,
    avgEfficiencyScore: 65,
    totalToolCalls: 200,
    totalTasksCompleted: 8,
    taskSuccessRate: 0.8,
    toolBreakdown: { Read: 80, Edit: 60, Bash: 60 },
    antiPatternCounts: { stuck_loop: 2, thrashing: 1 },
    ...overrides,
  };
}

function makeWeeklySummary(weekId: string, developer: string, statsOverrides = {}): WeeklySummary {
  return {
    week: weekId,
    generatedAt: Date.now(),
    developers: [developer],
    sessionCount: 10,
    totalCostUsd: 5.0,
    avgCostPerSession: 0.5,
    avgEfficiencyScore: 65,
    totalToolCalls: 200,
    toolBreakdown: {},
    totalTasksCompleted: 8,
    taskSuccessRate: 0.8,
    antiPatternCounts: {},
    perDeveloper: {
      [developer]: makeWeeklyStats(statsOverrides),
    },
    perPlatform: {},
  };
}

function makeSummaryGenerator(summaries: WeeklySummary[]): WeeklySummaryGenerator {
  return {
    loadRecentWeeks: jest.fn<WeeklySummary[], [number]>().mockReturnValue(summaries),
  } as unknown as WeeklySummaryGenerator;
}

describe('PersonalCoach', () => {
  const developer = 'testuser';

  it('returns insufficient_data when fewer than 2 weeks available', () => {
    const gen = makeSummaryGenerator([makeWeeklySummary('2026-W01', developer)]);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('insufficient_data');
    if (result.status === 'insufficient_data') {
      expect(result.weeksAvailable).toBe(1);
      expect(result.weeksRequired).toBe(2);
      expect(result.developer).toBe(developer);
      expect(result.message).toBeTruthy();
    }
  });

  it('returns insufficient_data when no weeks available', () => {
    const gen = makeSummaryGenerator([]);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('insufficient_data');
  });

  it('returns ok when 2+ weeks available', () => {
    const summaries = [
      makeWeeklySummary('2026-W02', developer),
      makeWeeklySummary('2026-W01', developer),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
  });

  it('thisWeek reflects the most recent summary', () => {
    const summaries = [
      makeWeeklySummary('2026-W02', developer, { totalCostUsd: 8.0, sessionCount: 12 }),
      makeWeeklySummary('2026-W01', developer, { totalCostUsd: 5.0, sessionCount: 10 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(result.thisWeek.weekId).toBe('2026-W02');
      expect(result.thisWeek.totalCostUsd).toBe(8.0);
    }
  });

  it('highlights improvement when efficiency is above baseline ([0,1] scale values)', () => {
    // avgEfficiencyScore is stored as [0,1] (raw EfficiencyScorer output).
    // delta = 0.80 - 0.60 = 0.20 which is >= 0.05 (5 percentage-point improvement).
    // The threshold in code must compare against the scaled delta (×100), not raw delta.
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 0.8 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 0.6 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 0.6 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 0.6 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.highlights.some((h) => h.toLowerCase().includes('efficiency'))).toBe(true);
    }
  });

  it('flags efficiency regression against baseline ([0,1] scale values)', () => {
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 0.5 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 0.7 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 0.7 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 0.7 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.regressions.some((r) => r.toLowerCase().includes('efficiency'))).toBe(true);
    }
  });

  it('flags regression when cost-per-session spikes above baseline', () => {
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { totalCostUsd: 20.0, sessionCount: 10 }),
      makeWeeklySummary('2026-W03', developer, { totalCostUsd: 5.0, sessionCount: 10 }),
      makeWeeklySummary('2026-W02', developer, { totalCostUsd: 5.0, sessionCount: 10 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(result.regressions.some((r) => r.includes('Cost per session'))).toBe(true);
    }
  });

  it('detects efficiency streak over 3 consecutive improving weeks', () => {
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 80 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 70 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 60 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 50 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(result.streaks.length).toBeGreaterThan(0);
      expect(result.streaks[0]).toContain('3 consecutive');
    }
  });

  it('topRecommendation is a non-empty string in all cases', () => {
    const summaries = [
      makeWeeklySummary('2026-W02', developer),
      makeWeeklySummary('2026-W01', developer),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(typeof result.topRecommendation).toBe('string');
      expect(result.topRecommendation.length).toBeGreaterThan(0);
    }
  });

  it('topRecommendation returns efficiency-specific message when score drops 5+ points vs baseline', () => {
    // baseline avg = 0.75, this week = 0.60 → drop of 0.15 = 15 points on 0–100 scale (>5)
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 0.6 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 0.75 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 0.75 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 0.75 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.topRecommendation).toContain('Efficiency is below');
    }
  });

  it('topRecommendation returns positive reinforcement when efficiency >= 70/100', () => {
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 0.85 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 0.85 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 0.85 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 0.85 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.topRecommendation).toContain('Strong week');
    }
  });

  it('ignores weeks where the developer has no sessions', () => {
    const summaryWithoutDev: WeeklySummary = {
      ...makeWeeklySummary('2026-W03', 'other_developer'),
      perDeveloper: { other_developer: makeWeeklyStats() }, // testuser absent
    };
    const summaries = [
      summaryWithoutDev,
      makeWeeklySummary('2026-W02', developer),
      makeWeeklySummary('2026-W01', developer),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    // Should still work with 2 valid weeks; week with no data for this developer is skipped
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.weeksAnalyzed).toBe(2);
    }
  });

  it('flags anti-pattern regression against baseline and prioritizes it in topRecommendation', () => {
    // baseline rate (thrashing:3/200=0.015 across 3 weeks) vs this week (stuck_loop:10/200=0.05)
    // is a >25% spike, and thisWeek.antiPatternRate > baseline.antiPatternRate * 1.25.
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { antiPatternCounts: { stuck_loop: 10 } }),
      makeWeeklySummary('2026-W03', developer, { antiPatternCounts: { thrashing: 3 } }),
      makeWeeklySummary('2026-W02', developer, { antiPatternCounts: { thrashing: 3 } }),
      makeWeeklySummary('2026-W01', developer, { antiPatternCounts: { thrashing: 3 } }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(
        result.regressions.some((r) => r.includes('Anti-pattern rate') && r.includes('stuck loop')),
      ).toBe(true);
      expect(result.topRecommendation).toContain('Focus on reducing "stuck loop"');
    }
  });

  it('baseline metrics do not contain NaN', () => {
    const summaries = [
      makeWeeklySummary('2026-W02', developer),
      makeWeeklySummary('2026-W01', developer),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(typeof result.topRecommendation).toBe('string');
      expect(result.topRecommendation.length).toBeGreaterThan(0);
      // Verify all numeric baseline metrics are finite numbers (not NaN or Infinity)
      expect(Number.isFinite(result.baseline.totalCostUsd)).toBe(true);
      expect(Number.isFinite(result.baseline.avgCostPerSession)).toBe(true);
      expect(Number.isFinite(result.baseline.antiPatternCount)).toBe(true);
      expect(Number.isFinite(result.baseline.antiPatternRate)).toBe(true);
      expect(Number.isFinite(result.baseline.sessionsCount)).toBe(true);
      expect(Number.isFinite(result.baseline.avgToolCallsPerSession)).toBe(true);
      if (result.baseline.avgEfficiencyScore !== null) {
        expect(Number.isFinite(result.baseline.avgEfficiencyScore)).toBe(true);
      }
    }
  });
});
