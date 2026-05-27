import { createLogger } from '../shared/index.js';
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

// ---------------------------------------------------------------------------
// PersonalCoach
// ---------------------------------------------------------------------------

const WEEKS_REQUIRED = 2;
const WEEKS_TO_LOAD = 8;

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

  private loadDeveloperWeeks(): Array<{ weekId: string; stats: DeveloperWeeklyStats }> {
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

  private computeBaseline(
    weeks: Array<{ weekId: string; stats: DeveloperWeeklyStats }>,
  ): PersonalWeekMetrics {
    const metrics = weeks.map(w => this.toPersonalWeekMetrics(w));

    const mean = (values: number[]): number => {
      if (values.length === 0) return 0;
      return values.reduce((a, b) => a + b, 0) / values.length;
    };

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
          `Your efficiency score this week (${thisWeek.avgEfficiencyScore.toFixed(0)}) is ${delta.toFixed(0)} points above your historical average.`,
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
          ? ` Most frequent: ${thisWeek.topAntiPattern.replace(/_/g, ' ')}.`
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
        const pattern = thisWeek.topAntiPattern.replace(/_/g, ' ');
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
