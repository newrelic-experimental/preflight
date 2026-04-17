/**
 * Prompt Engineering Feedback Loop — combines collaboration profiles (4.3),
 * CLAUDE.md impact tracking (4.4), and trend analysis (4.2) into actionable
 * prompt engineering recommendations.
 *
 * Features:
 *   1. Correlation analysis: how prompt behaviors correlate with outcomes
 *   2. CLAUDE.md A/B comparison with Cohen's d effect sizes
 *   3. Rule-based recommendation generation with evidence and priority
 *   4. Metric emission for NR dashboards
 */

import type { MetricAggregator } from '@nr-ai-observatory/shared';
import { createLogger } from '@nr-ai-observatory/shared';
import type { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { CollaborationProfiler } from './collaboration-profile.js';
import type { ClaudeMdTracker } from './claudemd-tracker.js';
import { percentChange } from './trend-analyzer.js';

const logger = createLogger('prompt-feedback');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptCorrelation {
  readonly behavior: string;
  readonly metric: string;
  readonly withBehaviorAvg: number;
  readonly withoutBehaviorAvg: number;
  readonly delta: number;
  readonly percentChange: number;
  readonly sessionsWith: number;
  readonly sessionsWithout: number;
}

export interface EffectSize {
  readonly metric: string;
  readonly cohensD: number;
  readonly label: 'significant' | 'moderate' | 'noise';
}

export interface ClaudeMdAbComparison {
  readonly changeTimestamp: number;
  readonly effectSizes: EffectSize[];
  readonly overallLabel: 'significant' | 'moderate' | 'noise';
}

export interface PromptRecommendation {
  readonly category: string;
  readonly message: string;
  readonly evidence: string;
  readonly estimatedImpact: string;
  readonly priority: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// PromptFeedbackEngine
// ---------------------------------------------------------------------------

export class PromptFeedbackEngine {
  private readonly sessionStore: SessionStore;
  private readonly collaborationProfiler: CollaborationProfiler;
  private readonly claudeMdTracker: ClaudeMdTracker;

  constructor(options: {
    sessionStore: SessionStore;
    collaborationProfiler: CollaborationProfiler;
    claudeMdTracker: ClaudeMdTracker;
  }) {
    this.sessionStore = options.sessionStore;
    this.collaborationProfiler = options.collaborationProfiler;
    this.claudeMdTracker = options.claudeMdTracker;
  }

  /**
   * Analyze how a developer's prompting behaviors correlate with session
   * outcomes (efficiency). Returns correlations sorted by impact.
   */
  correlatePromptStyleWithOutcomes(
    developer: string,
    windowWeeks: number = 8,
  ): PromptCorrelation[] {
    const since = new Date(Date.now() - windowWeeks * 7 * 86_400_000);
    const sessions = this.sessionStore.loadAllSessions({ since, developer });

    if (sessions.length < 2) return [];

    const behaviors: Array<{
      name: string;
      test: (s: FullSessionSummary) => boolean;
    }> = [
      {
        name: 'provides file paths',
        test: (s) => {
          if (s.toolCallCount === 0) return false;
          const readRatio = (s.toolBreakdown.Read ?? 0) / s.toolCallCount;
          return s.filesModified.length > 0 && readRatio < 0.3;
        },
      },
      {
        name: 'multi-step tasks',
        test: (s) => s.taskCount >= 2,
      },
      {
        name: 'uses plan mode',
        test: (s) => (s.toolBreakdown.EnterPlanMode ?? 0) > 0,
      },
    ];

    const correlations: PromptCorrelation[] = [];

    for (const behavior of behaviors) {
      const withBehavior = sessions.filter(behavior.test);
      const withoutBehavior = sessions.filter((s) => !behavior.test(s));

      if (withBehavior.length === 0 || withoutBehavior.length === 0) continue;

      const withAvg = avgEfficiency(withBehavior);
      const withoutAvg = avgEfficiency(withoutBehavior);

      if (withAvg === null || withoutAvg === null) continue;

      const delta = round(withAvg - withoutAvg, 3);
      const pct = percentChange(withoutAvg, withAvg);

      correlations.push({
        behavior: behavior.name,
        metric: 'efficiency',
        withBehaviorAvg: withAvg,
        withoutBehaviorAvg: withoutAvg,
        delta,
        percentChange: pct,
        sessionsWith: withBehavior.length,
        sessionsWithout: withoutBehavior.length,
      });
    }

    return correlations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  /**
   * Compare before/after CLAUDE.md change with Cohen's d effect sizes.
   */
  compareClaudeMdVersions(
    changeTimestamp: number,
    windowDays: number = 7,
  ): ClaudeMdAbComparison {
    const windowMs = windowDays * 86_400_000;
    const allSessions = this.sessionStore.loadAllSessions();

    const beforeSessions = allSessions.filter(
      (s) => s.startTime >= changeTimestamp - windowMs && s.startTime < changeTimestamp,
    );
    const afterSessions = allSessions.filter(
      (s) => s.startTime >= changeTimestamp && s.startTime <= changeTimestamp + windowMs,
    );

    const metrics: Array<{
      name: string;
      extract: (s: FullSessionSummary) => number | null;
    }> = [
      { name: 'efficiency', extract: (s) => s.efficiencyScore },
      { name: 'cost', extract: (s) => s.estimatedCostUsd },
      { name: 'taskSuccessRate', extract: (s) => s.taskSuccessRate },
    ];

    const effectSizes: EffectSize[] = [];

    for (const m of metrics) {
      const beforeValues = beforeSessions.map(m.extract).filter((v): v is number => v !== null);
      const afterValues = afterSessions.map(m.extract).filter((v): v is number => v !== null);

      if (beforeValues.length < 1 || afterValues.length < 1) {
        effectSizes.push({ metric: m.name, cohensD: 0, label: 'noise' });
        continue;
      }

      const d = cohensD(beforeValues, afterValues);
      effectSizes.push({
        metric: m.name,
        cohensD: round(d, 3),
        label: labelEffectSize(d),
      });
    }

    // Overall label from majority
    const labelCounts = { significant: 0, moderate: 0, noise: 0 };
    for (const es of effectSizes) labelCounts[es.label]++;

    let overallLabel: EffectSize['label'] = 'noise';
    if (labelCounts.significant >= labelCounts.moderate && labelCounts.significant >= labelCounts.noise) {
      overallLabel = 'significant';
    } else if (labelCounts.moderate >= labelCounts.noise) {
      overallLabel = 'moderate';
    }

    return { changeTimestamp, effectSizes, overallLabel };
  }

  /**
   * Generate actionable prompt engineering recommendations based on the
   * developer's profile, anti-patterns, and CLAUDE.md impact data.
   */
  generatePromptRecommendations(
    developer: string,
    options?: { since?: Date },
  ): PromptRecommendation[] {
    const profile = this.collaborationProfiler.computeProfile(developer, options);
    const baseline = this.collaborationProfiler.computeTeamBaseline(options);
    const sessions = this.sessionStore.loadAllSessions({
      since: options?.since,
      developer,
    });

    const recommendations: PromptRecommendation[] = [];

    // Rule 1: High correction rate
    // correctionRate is inverted (1.0 = no corrections), so low correctionRate = many corrections
    const correctionPct = round((1 - profile.dimensions.correctionRate) * 100, 0);
    const teamCorrectionPct = round((1 - baseline.dimensions.correctionRate) * 100, 0);
    if (1 - profile.dimensions.correctionRate > 0.3) {
      recommendations.push({
        category: 'prompt_context',
        message: 'Consider providing more context in initial prompts — your correction rate is high compared to team average',
        evidence: `Your correction rate is ${correctionPct}%, vs team average ${teamCorrectionPct}%`,
        estimatedImpact: 'Fewer corrections could reduce session duration by 15-25%',
        priority: 'high',
      });
    }

    // Rule 2: High complexity + low autonomy
    if (profile.dimensions.taskComplexity >= 0.5 && profile.dimensions.autonomy < 0.5) {
      recommendations.push({
        category: 'plan_mode',
        message: 'For complex tasks, try using /plan mode to align on approach before implementation',
        evidence: `Task complexity: ${round(profile.dimensions.taskComplexity, 2)}, autonomy: ${round(profile.dimensions.autonomy, 2)}`,
        estimatedImpact: 'Plan mode can improve first-attempt quality for complex tasks',
        priority: 'medium',
      });
    }

    // Rule 3: Poor read efficiency (re_reading anti-pattern)
    if (sessions.length > 0) {
      const sessionsWithReReading = sessions.filter((s) =>
        s.antiPatterns.some((ap) => ap.type === 're_reading'),
      );
      const reReadingPct = round((sessionsWithReReading.length / sessions.length) * 100, 0);

      if (reReadingPct > 50) {
        recommendations.push({
          category: 'file_paths',
          message: 'Your sessions show frequent file re-reads. Adding relevant file paths to your initial prompt can reduce this',
          evidence: `${reReadingPct}% of sessions (${sessionsWithReReading.length}/${sessions.length}) exhibit re-reading patterns`,
          estimatedImpact: 'Providing file paths upfront can reduce tool calls by 10-20%',
          priority: 'medium',
        });
      }
    }

    // Rule 4: Negative CLAUDE.md impact
    const changes = this.claudeMdTracker.getChanges();
    if (changes.length > 0) {
      const latestChange = changes[changes.length - 1]!;
      const impact = this.claudeMdTracker.computeImpact(latestChange.timestamp);

      if (impact.verdict.startsWith('Negative')) {
        const costPct = Math.abs(impact.deltas.cost.percentChange);
        recommendations.push({
          category: 'claudemd_impact',
          message: 'Recent CLAUDE.md update had a negative impact on metrics. Consider reverting or refining the changes',
          evidence: `${impact.verdict}. Cost changed by ${impact.deltas.cost.percentChange}%, efficiency by ${impact.deltas.efficiencyScore.percentChange}%`,
          estimatedImpact: `Reverting could save ~${costPct}% on costs`,
          priority: 'high',
        });
      }
    }

    // Sort by priority (high first)
    recommendations.sort(
      (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2),
    );

    logger.debug('Prompt recommendations generated', {
      developer,
      count: recommendations.length,
    });

    return recommendations;
  }

  /**
   * Emit recommendation metrics to New Relic.
   */
  emitMetrics(
    aggregator: MetricAggregator,
    developer: string,
    options?: { since?: Date },
  ): void {
    const recommendations = this.generatePromptRecommendations(developer, options);

    for (const rec of recommendations) {
      aggregator.record('ai.prompt_recommendation', 1, {
        developer,
        category: rec.category,
        priority: rec.priority,
      });
    }

    logger.debug('Prompt recommendation metrics emitted', {
      developer,
      count: recommendations.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/**
 * Cohen's d effect size: difference of means divided by pooled standard deviation.
 */
function cohensD(groupA: number[], groupB: number[]): number {
  const meanA = mean(groupA);
  const meanB = mean(groupB);
  const sdA = stddev(groupA, meanA);
  const sdB = stddev(groupB, meanB);

  // Pooled standard deviation
  const nA = groupA.length;
  const nB = groupB.length;

  if (nA + nB < 2) return 0;

  const pooledVariance =
    ((nA - 1) * sdA * sdA + (nB - 1) * sdB * sdB) / (nA + nB - 2);
  const pooledSd = Math.sqrt(pooledVariance);

  if (pooledSd === 0) return meanA === meanB ? 0 : Infinity;

  return Math.abs(meanB - meanA) / pooledSd;
}

function labelEffectSize(d: number): EffectSize['label'] {
  const absD = Math.abs(d);
  if (absD > 0.5) return 'significant';
  if (absD >= 0.2) return 'moderate';
  return 'noise';
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  let sqDiffSum = 0;
  for (const v of values) sqDiffSum += (v - avg) ** 2;
  return Math.sqrt(sqDiffSum / (values.length - 1));
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function avgEfficiency(sessions: FullSessionSummary[]): number | null {
  const scores = sessions
    .map((s) => s.efficiencyScore)
    .filter((v): v is number => v !== null);
  if (scores.length === 0) return null;
  return round(mean(scores), 3);
}

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
