# Implementation Plan: Personal Coaching MCP Tool

**Roadmap item:** [15 — Personal Coaching MCP Tool](../../ROADMAP.md#15-personal-coaching-mcp-tool)
**Effort estimate:** ~1.5 days
**Prerequisites:**
- Item 12 (developer identity normalisation) — the `developer` field must be stable
- Item 9 (team and org analytics) is **not** required — `PersonalCoach` reads from `WeeklySummaryGenerator` directly, which already exists
- `WeeklySummaryGenerator` and `SessionStore` must be available in the running `NrMcpServer` instance (they are wired up by item 9's prerequisite work in `server.ts`, but the `cross-session-tools.ts` conditional-registration pattern handles the case where they're absent)

---

## Goal

Add a new MCP tool `nr_observe_get_personal_insights` that produces a narrative coaching report by comparing the developer's current week against their own historical baseline. The report surfaces actionable observations ("you re-read files 40% more than your average this week") rather than raw numbers. No external AI call is made — narrative strings are generated from template expressions over computed deltas.

The tool degrades gracefully: when fewer than 2 weeks of data exist it returns a structured `insufficient_data` response rather than empty or misleading output.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts` — `WeeklySummary`, `DeveloperWeeklyStats`, `WeeklySummaryGenerator`, `getIsoWeekId()`, `getWeekDateRange()` — the data source for all personal metrics
- `packages/nr-ai-mcp-server/src/storage/session-store.ts` — `FullSessionSummary`, `SessionStore` — for accessing individual session data when computing re-read rates
- `packages/nr-ai-mcp-server/src/metrics/recommendation-engine.ts` — `Recommendation` interface and priority system — match the narrative style
- `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts` — where the new MCP tool will be registered; study how `WEEKLY_SUMMARY_TOOL` and `TRENDS_TOOL` are registered conditionally based on available trackers
- `packages/nr-ai-mcp-server/src/server.ts` — how `SessionStore` and `WeeklySummaryGenerator` are constructed and passed to `registerTools()` / `registerCrossSessionTools()`
- `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts` — `TrendAnalyzer.getWeeklyTrends()` — compare approach; `PersonalCoach` is simpler but similar in spirit

---

## Step 1 — Define types in `src/metrics/personal-coach.ts`

Create `packages/nr-ai-mcp-server/src/metrics/personal-coach.ts`. Start with the type definitions:

```typescript
import { createLogger } from '@nr-ai-observatory/shared';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import type { DeveloperWeeklyStats } from '../storage/weekly-summary.js';

const logger = createLogger('personal-coach');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalWeekMetrics {
  readonly weekId: string;
  readonly totalCostUsd: number;
  readonly avgCostPerSession: number;
  readonly avgEfficiencyScore: number | null;
  readonly antiPatternCount: number;
  readonly antiPatternRate: number;           // antiPatterns / totalToolCalls, 0 if no calls
  readonly sessionsCount: number;
  readonly avgToolCallsPerSession: number;
  readonly topAntiPattern: string | null;     // most frequent patternType this week, or null
}

export interface PersonalInsightsReport {
  readonly status: 'ok';
  readonly developer: string;
  readonly generatedAt: number;
  readonly weeksAnalyzed: number;
  readonly highlights: readonly string[];     // positive observations
  readonly regressions: readonly string[];    // negative observations
  readonly streaks: readonly string[];        // sustained patterns (good or bad)
  readonly topRecommendation: string;
  readonly thisWeek: PersonalWeekMetrics;
  readonly lastWeek: PersonalWeekMetrics | null;   // null if only one week available
  readonly baseline: PersonalWeekMetrics;          // mean across all available weeks
}

export interface PersonalInsightsInsufficientData {
  readonly status: 'insufficient_data';
  readonly developer: string;
  readonly weeksAvailable: number;
  readonly weeksRequired: number;
  readonly message: string;
}

export type PersonalInsightsResult = PersonalInsightsReport | PersonalInsightsInsufficientData;
```

---

## Step 2 — Implement `PersonalCoach`

Continue in `personal-coach.ts`:

```typescript
const WEEKS_REQUIRED = 2;
const WEEKS_TO_LOAD = 8;  // how far back to look for history

export class PersonalCoach {
  private readonly summaryGenerator: WeeklySummaryGenerator;
  private readonly developer: string;

  constructor(summaryGenerator: WeeklySummaryGenerator, developer: string) {
    this.summaryGenerator = summaryGenerator;
    this.developer = developer;
  }

  generate(): PersonalInsightsResult {
    const weeks = this.loadDeveloperWeeks();

    if (weeks.length < WEEKS_REQUIRED) {
      return {
        status: 'insufficient_data',
        developer: this.developer,
        weeksAvailable: weeks.length,
        weeksRequired: WEEKS_REQUIRED,
        message: `Need at least ${WEEKS_REQUIRED} weeks of session history to generate personal insights. ` +
          `Currently have ${weeks.length}. Keep using the AI coding assistant and check back next week.`,
      };
    }

    const thisWeekData = weeks[0]!;         // most recent week (index 0)
    const lastWeekData = weeks[1] ?? null;  // second most recent

    // Baseline = mean across all loaded weeks
    const baseline = this.computeBaseline(weeks);

    const thisWeek = this.toPersonalWeekMetrics(thisWeekData);
    const lastWeek = lastWeekData ? this.toPersonalWeekMetrics(lastWeekData) : null;

    const highlights = this.buildHighlights(thisWeek, lastWeek, baseline);
    const regressions = this.buildRegressions(thisWeek, lastWeek, baseline);
    const streaks = this.buildStreaks(weeks);
    const topRecommendation = this.buildTopRecommendation(regressions, thisWeek, baseline);

    logger.debug('Personal insights generated', {
      developer: this.developer,
      weeksAnalyzed: weeks.length,
      highlights: highlights.length,
      regressions: regressions.length,
    });

    return {
      status: 'ok',
      developer: this.developer,
      generatedAt: Date.now(),
      weeksAnalyzed: weeks.length,
      highlights,
      regressions,
      streaks,
      topRecommendation,
      thisWeek,
      lastWeek,
      baseline,
    };
  }
```

### 2a — `loadDeveloperWeeks`

```typescript
  private loadDeveloperWeeks(): Array<{ weekId: string; stats: DeveloperWeeklyStats }> {
    // WeeklySummaryGenerator.loadRecentWeeks() returns WeeklySummary[] sorted newest-first
    const summaries = this.summaryGenerator.loadRecentWeeks(WEEKS_TO_LOAD);
    const result: Array<{ weekId: string; stats: DeveloperWeeklyStats }> = [];

    for (const summary of summaries) {
      const devStats = summary.perDeveloper[this.developer];
      if (devStats && devStats.sessionCount > 0) {
        result.push({ weekId: summary.week, stats: devStats });
      }
    }

    return result;
  }
```

> Check `WeeklySummaryGenerator` for the correct method name to load historical summaries. If `loadRecentWeeks(n)` does not exist, use whatever method is available to load the last N weeks' summaries from disk. The method should return `WeeklySummary[]`.

### 2b — `toPersonalWeekMetrics`

```typescript
  private toPersonalWeekMetrics(
    data: { weekId: string; stats: DeveloperWeeklyStats },
  ): PersonalWeekMetrics {
    const { weekId, stats } = data;
    const antiPatternTotal = Object.values(stats.antiPatternCounts).reduce((a, b) => a + b, 0);
    const antiPatternRate = stats.totalToolCalls > 0
      ? antiPatternTotal / stats.totalToolCalls
      : 0;

    // Find the most frequent anti-pattern this week
    let topAntiPattern: string | null = null;
    let topCount = 0;
    for (const [pattern, count] of Object.entries(stats.antiPatternCounts)) {
      if (count > topCount) {
        topCount = count;
        topAntiPattern = pattern;
      }
    }

    return {
      weekId,
      totalCostUsd: stats.totalCostUsd,
      avgCostPerSession: stats.sessionCount > 0 ? stats.totalCostUsd / stats.sessionCount : 0,
      avgEfficiencyScore: stats.avgEfficiencyScore,
      antiPatternCount: antiPatternTotal,
      antiPatternRate,
      sessionsCount: stats.sessionCount,
      avgToolCallsPerSession: stats.sessionCount > 0 ? stats.totalToolCalls / stats.sessionCount : 0,
      topAntiPattern,
    };
  }
```

### 2c — `computeBaseline`

```typescript
  private computeBaseline(
    weeks: Array<{ weekId: string; stats: DeveloperWeeklyStats }>,
  ): PersonalWeekMetrics {
    const metrics = weeks.map(w => this.toPersonalWeekMetrics(w));
    const n = metrics.length;

    const mean = (values: number[]): number =>
      values.reduce((a, b) => a + b, 0) / values.length;

    const efficiencyScores = metrics
      .map(m => m.avgEfficiencyScore)
      .filter((v): v is number => v !== null);

    // For topAntiPattern in baseline: use the most frequently appearing pattern
    const patternFrequency: Record<string, number> = {};
    for (const m of metrics) {
      if (m.topAntiPattern) {
        patternFrequency[m.topAntiPattern] = (patternFrequency[m.topAntiPattern] ?? 0) + 1;
      }
    }
    const baselineTopAntiPattern = Object.entries(patternFrequency)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      weekId: 'baseline',
      totalCostUsd: mean(metrics.map(m => m.totalCostUsd)),
      avgCostPerSession: mean(metrics.map(m => m.avgCostPerSession)),
      avgEfficiencyScore: efficiencyScores.length > 0 ? mean(efficiencyScores) : null,
      antiPatternCount: mean(metrics.map(m => m.antiPatternCount)),
      antiPatternRate: mean(metrics.map(m => m.antiPatternRate)),
      sessionsCount: mean(metrics.map(m => m.sessionsCount)),
      avgToolCallsPerSession: mean(metrics.map(m => m.avgToolCallsPerSession)),
      topAntiPattern: baselineTopAntiPattern,
    };
  }
```

### 2d — Narrative generators

These methods produce human-readable strings from computed deltas. Use percentage-change comparisons with a minimum `SIGNIFICANT_DELTA` threshold to avoid noise.

```typescript
  private buildHighlights(
    thisWeek: PersonalWeekMetrics,
    lastWeek: PersonalWeekMetrics | null,
    baseline: PersonalWeekMetrics,
  ): string[] {
    const highlights: string[] = [];

    // Efficiency improvement vs baseline
    if (thisWeek.avgEfficiencyScore !== null && baseline.avgEfficiencyScore !== null) {
      const delta = thisWeek.avgEfficiencyScore - baseline.avgEfficiencyScore;
      if (delta >= 5) {
        highlights.push(
          `Your efficiency score this week (${thisWeek.avgEfficiencyScore.toFixed(0)}) is ${delta.toFixed(0)} points above your ${baseline.weekId === 'baseline' ? 'historical' : ''} average.`,
        );
      }
    }

    // Cost per session improvement vs baseline
    if (baseline.avgCostPerSession > 0) {
      const pct = (thisWeek.avgCostPerSession - baseline.avgCostPerSession) / baseline.avgCostPerSession;
      if (pct <= -0.15) {
        highlights.push(
          `You spent ${Math.abs(pct * 100).toFixed(0)}% less per session this week ($${thisWeek.avgCostPerSession.toFixed(2)}) than your average ($${baseline.avgCostPerSession.toFixed(2)}).`,
        );
      }
    }

    // Anti-pattern rate improvement vs last week
    if (lastWeek && lastWeek.antiPatternRate > 0) {
      const pct = (thisWeek.antiPatternRate - lastWeek.antiPatternRate) / lastWeek.antiPatternRate;
      if (pct <= -0.20) {
        highlights.push(
          `Anti-pattern rate dropped ${Math.abs(pct * 100).toFixed(0)}% week-over-week (${(thisWeek.antiPatternRate * 100).toFixed(1)}% vs ${(lastWeek.antiPatternRate * 100).toFixed(1)}%).`,
        );
      }
    }

    return highlights;
  }

  private buildRegressions(
    thisWeek: PersonalWeekMetrics,
    lastWeek: PersonalWeekMetrics | null,
    baseline: PersonalWeekMetrics,
  ): string[] {
    const regressions: string[] = [];

    // Efficiency drop vs baseline
    if (thisWeek.avgEfficiencyScore !== null && baseline.avgEfficiencyScore !== null) {
      const delta = thisWeek.avgEfficiencyScore - baseline.avgEfficiencyScore;
      if (delta <= -5) {
        regressions.push(
          `Efficiency score this week (${thisWeek.avgEfficiencyScore.toFixed(0)}) is ${Math.abs(delta).toFixed(0)} points below your historical average (${baseline.avgEfficiencyScore.toFixed(0)}).`,
        );
      }
    }

    // Cost spike vs baseline
    if (baseline.avgCostPerSession > 0) {
      const pct = (thisWeek.avgCostPerSession - baseline.avgCostPerSession) / baseline.avgCostPerSession;
      if (pct >= 0.25) {
        regressions.push(
          `Cost per session this week ($${thisWeek.avgCostPerSession.toFixed(2)}) is ${(pct * 100).toFixed(0)}% above your average ($${baseline.avgCostPerSession.toFixed(2)}).`,
        );
      }
    }

    // Anti-pattern rate spike vs baseline
    if (baseline.antiPatternRate > 0) {
      const pct = (thisWeek.antiPatternRate - baseline.antiPatternRate) / baseline.antiPatternRate;
      if (pct >= 0.25) {
        const patternNote = thisWeek.topAntiPattern
          ? ` Most frequent: ${thisWeek.topAntiPattern.replace('_', ' ')}.`
          : '';
        regressions.push(
          `Anti-pattern rate (${(thisWeek.antiPatternRate * 100).toFixed(1)}%) is ${(pct * 100).toFixed(0)}% above your average.${patternNote}`,
        );
      }
    }

    return regressions;
  }

  private buildStreaks(
    weeks: Array<{ weekId: string; stats: DeveloperWeeklyStats }>,
  ): string[] {
    if (weeks.length < 3) return [];

    const streaks: string[] = [];
    const metrics = weeks.map(w => this.toPersonalWeekMetrics(w));

    // Consecutive efficiency improvement streak
    let efficiencyStreakLen = 0;
    for (let i = 0; i < metrics.length - 1; i++) {
      const curr = metrics[i]!.avgEfficiencyScore;
      const prev = metrics[i + 1]!.avgEfficiencyScore;
      if (curr !== null && prev !== null && curr > prev) {
        efficiencyStreakLen++;
      } else {
        break;
      }
    }
    if (efficiencyStreakLen >= 2) {
      streaks.push(`Efficiency score has improved for ${efficiencyStreakLen} consecutive weeks. Keep it up.`);
    }

    // Consecutive cost-per-session reduction streak
    let costStreakLen = 0;
    for (let i = 0; i < metrics.length - 1; i++) {
      if (metrics[i]!.avgCostPerSession < metrics[i + 1]!.avgCostPerSession) {
        costStreakLen++;
      } else {
        break;
      }
    }
    if (costStreakLen >= 2) {
      streaks.push(`Cost per session has decreased for ${costStreakLen} consecutive weeks.`);
    }

    return streaks;
  }

  private buildTopRecommendation(
    regressions: string[],
    thisWeek: PersonalWeekMetrics,
    baseline: PersonalWeekMetrics,
  ): string {
    // Prioritise the most impactful regression as the top recommendation
    if (regressions.length > 0) {
      // Determine which regression is most actionable
      if (thisWeek.antiPatternRate > baseline.antiPatternRate * 1.25 && thisWeek.topAntiPattern) {
        const pattern = thisWeek.topAntiPattern.replace('_', ' ');
        return `Focus on reducing "${pattern}" patterns this week — they're your top efficiency drain.`;
      }
      if (thisWeek.avgCostPerSession > baseline.avgCostPerSession * 1.25) {
        return 'Review your longest sessions this week and identify which tasks could be broken into smaller, more focused sessions.';
      }
      if (thisWeek.avgEfficiencyScore !== null && baseline.avgEfficiencyScore !== null &&
          thisWeek.avgEfficiencyScore < baseline.avgEfficiencyScore - 5) {
        return 'Efficiency is below your average. Try writing more specific task descriptions before starting a session.';
      }
      return regressions[0]!;
    }

    // No regressions — give a positive reinforcement message
    if (thisWeek.avgEfficiencyScore !== null && thisWeek.avgEfficiencyScore >= 70) {
      return 'Strong week. Consider documenting what worked well in your CLAUDE.md to lock in these patterns.';
    }

    return 'No significant changes detected this week. Maintain your current patterns and check back next week.';
  }
}
```

---

## Step 3 — Check `WeeklySummaryGenerator` for `loadRecentWeeks`

Before registering the tool, verify that `WeeklySummaryGenerator` exposes a method to load multiple weekly summaries. Look in `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts`.

If `loadRecentWeeks(n: number): WeeklySummary[]` does not exist, add it:

```typescript
// In WeeklySummaryGenerator class, after existing methods:

loadRecentWeeks(count: number): WeeklySummary[] {
  const summariesDir = join(this.storagePath, 'weekly_summaries');
  if (!existsSync(summariesDir)) return [];

  const files = readdirSync(summariesDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()  // newest first
    .slice(0, count);

  const results: WeeklySummary[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(summariesDir, file), 'utf-8');
      results.push(JSON.parse(raw) as WeeklySummary);
    } catch {
      logger.warn('Skipping unreadable weekly summary', { file });
    }
  }

  return results;
}
```

---

## Step 4 — Register the MCP tool in `cross-session-tools.ts`

In `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`:

### 4a — Import `PersonalCoach`

```typescript
import { PersonalCoach } from '../metrics/personal-coach.js';
```

### 4b — Define the tool descriptor constant

Add alongside the existing tool descriptor constants:

```typescript
export const PERSONAL_INSIGHTS_TOOL = {
  name: 'nr_observe_get_personal_insights',
  description:
    'Returns a narrative coaching report comparing this week\'s personal AI coding metrics against your historical baseline. ' +
    'Includes highlights, regressions, streaks, and a top recommendation. ' +
    'Requires at least 2 weeks of session history. ' +
    'Returns status: "insufficient_data" with a message when history is too sparse.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
} as const;
```

### 4c — Register the handler

In `registerCrossSessionTools()` (or wherever the cross-session tools are registered), add a conditional block for `PersonalInsights`. This tool requires `WeeklySummaryGenerator` and the resolved `developer` identity:

```typescript
if (summaryGenerator && developer) {
  const coach = new PersonalCoach(summaryGenerator, developer);

  server.tool(
    PERSONAL_INSIGHTS_TOOL.name,
    PERSONAL_INSIGHTS_TOOL.description,
    PERSONAL_INSIGHTS_TOOL.inputSchema,
    async () => {
      try {
        const result = coach.generate();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Error generating personal insights', { error: message });
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
```

> The `developer` string must flow into `registerCrossSessionTools` from the config. Add it as a parameter alongside the existing tracker parameters. Update the call site in `server.ts` to pass `config.developer`.

---

## Step 5 — Write tests

Create `packages/nr-ai-mcp-server/src/metrics/personal-coach.test.ts`.

```typescript
import { PersonalCoach } from './personal-coach.js';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import type { WeeklySummary } from '../storage/weekly-summary.js';

// Suppress logger output
beforeAll(() => { jest.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterAll(() => { jest.restoreAllMocks(); });

function makeWeeklyStats(overrides: Partial<{
  sessionCount: number;
  totalCostUsd: number;
  avgEfficiencyScore: number | null;
  totalToolCalls: number;
  totalTasksCompleted: number;
  taskSuccessRate: number | null;
  toolBreakdown: Record<string, number>;
  antiPatternCounts: Record<string, number>;
}> = {}) {
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

  it('highlights improvement when efficiency is above baseline', () => {
    const summaries = [
      makeWeeklySummary('2026-W04', developer, { avgEfficiencyScore: 80 }),
      makeWeeklySummary('2026-W03', developer, { avgEfficiencyScore: 60 }),
      makeWeeklySummary('2026-W02', developer, { avgEfficiencyScore: 60 }),
      makeWeeklySummary('2026-W01', developer, { avgEfficiencyScore: 60 }),
    ];
    const gen = makeSummaryGenerator(summaries);
    const coach = new PersonalCoach(gen, developer);
    const result = coach.generate();
    if (result.status === 'ok') {
      expect(result.highlights.length).toBeGreaterThan(0);
      expect(result.highlights[0]).toContain('efficiency');
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
      expect(result.regressions.some(r => r.includes('Cost per session'))).toBe(true);
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

  it('ignores weeks where the developer has no sessions', () => {
    const summaryWithoutDev: WeeklySummary = {
      ...makeWeeklySummary('2026-W03', 'other_developer'),
      perDeveloper: { other_developer: makeWeeklyStats() },  // testuser absent
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
});
```

---

## Acceptance criteria

- [ ] `PersonalCoach.generate()` returns `{ status: 'insufficient_data' }` when fewer than 2 weeks of data exist for the developer
- [ ] `PersonalCoach.generate()` returns `{ status: 'ok' }` with `highlights`, `regressions`, `streaks`, and `topRecommendation` when 2+ weeks exist
- [ ] `topRecommendation` is always a non-empty string
- [ ] Weeks where the configured developer has no sessions are silently skipped
- [ ] `nr_observe_get_personal_insights` is registered as an MCP tool only when both `WeeklySummaryGenerator` and `developer` are available
- [ ] The MCP tool returns valid JSON in both `ok` and `insufficient_data` cases
- [ ] All tests in `personal-coach.test.ts` pass
- [ ] `npm run build && npm test && npm run lint` all pass

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/metrics/personal-coach.ts
packages/nr-ai-mcp-server/src/metrics/personal-coach.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/storage/weekly-summary.ts     — add loadRecentWeeks() if not already present
packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts  — import PersonalCoach, add PERSONAL_INSIGHTS_TOOL constant, register handler
packages/nr-ai-mcp-server/src/server.ts                     — pass developer identity into registerCrossSessionTools()
```
