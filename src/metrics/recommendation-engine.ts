/**
 * Unified Recommendation Engine — synthesizes all analyzers into
 * a single prioritized, deduplicated recommendation list.
 *
 * Categories:
 *   - cost_optimization  — from CostPerOutcomeAnalyzer
 *   - efficiency         — from TrendAnalyzer
 *   - prompt_engineering — from PromptFeedbackEngine
 *   - claudemd           — from ClaudeMdTracker
 *   - model_selection    — from TrendAnalyzer.rankModelsByOutcome()
 */

import { createHash } from 'node:crypto';
import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
import type { TrendAnalyzer } from './trend-analyzer.js';
import type { CollaborationProfiler } from './collaboration-profile.js';
import type { ClaudeMdTracker } from './claudemd-tracker.js';
import type { PromptFeedbackEngine } from './prompt-feedback.js';
import type { CostPerOutcomeAnalyzer } from './cost-per-outcome.js';
import type { TaskDetector } from './task-detector.js';
import type { ModelUsageTracker } from './model-usage-tracker.js';

const logger = createLogger('recommendation-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Recommendation {
  readonly id: string;
  readonly category: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly title: string;
  readonly detail: string;
  readonly evidence: string;
  readonly estimatedSavings?: string;
  // Only set for 'prompt_engineering' recommendations — identifies which of
  // PromptFeedbackEngine's own sub-categories (prompt_context/plan_mode/
  // file_paths/claudemd_impact) produced this item. Lets callers dedupe
  // against other categories (e.g. 'claudemd_impact' restates the same
  // signal as the top-level 'claudemd' category) without parsing title text.
  readonly subCategory?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// Human-readable titles for PromptFeedbackEngine's sub-categories — its
// `category` field is a slug (e.g. 'plan_mode'), not display text. Falls
// back to the raw slug for any future category this map hasn't caught up to.
const PROMPT_RECOMMENDATION_TITLES: Record<string, string> = {
  prompt_context: 'High correction rate',
  plan_mode: 'Low autonomy on complex tasks',
  file_paths: 'Frequent file re-reads',
  claudemd_impact: 'Negative instruction-file impact',
};

// ---------------------------------------------------------------------------
// RecommendationEngine
// ---------------------------------------------------------------------------

export class RecommendationEngine {
  private readonly trendAnalyzer: TrendAnalyzer;
  private readonly collaborationProfiler: CollaborationProfiler;
  private readonly claudeMdTracker: ClaudeMdTracker;
  private readonly promptFeedbackEngine: PromptFeedbackEngine;
  private readonly costPerOutcomeAnalyzer: CostPerOutcomeAnalyzer;
  private readonly taskDetector?: TaskDetector;
  private readonly modelUsageTracker?: ModelUsageTracker;

  constructor(options: {
    trendAnalyzer: TrendAnalyzer;
    collaborationProfiler: CollaborationProfiler;
    claudeMdTracker: ClaudeMdTracker;
    promptFeedbackEngine: PromptFeedbackEngine;
    costPerOutcomeAnalyzer: CostPerOutcomeAnalyzer;
    taskDetector?: TaskDetector;
    modelUsageTracker?: ModelUsageTracker;
  }) {
    this.trendAnalyzer = options.trendAnalyzer;
    this.collaborationProfiler = options.collaborationProfiler;
    this.claudeMdTracker = options.claudeMdTracker;
    this.promptFeedbackEngine = options.promptFeedbackEngine;
    this.costPerOutcomeAnalyzer = options.costPerOutcomeAnalyzer;
    this.taskDetector = options.taskDetector;
    this.modelUsageTracker = options.modelUsageTracker;
  }

  /**
   * Generate all recommendations from all sub-analyzers, deduplicate,
   * sort by priority, and optionally limit to topN.
   */
  generateAllRecommendations(
    developer: string,
    options?: { topN?: number; since?: Date },
  ): Recommendation[] {
    const recs: Recommendation[] = [];

    recs.push(...this.getCostRecommendations(developer, options));
    recs.push(...this.getEfficiencyRecommendations(developer, options));
    recs.push(...this.getPromptRecommendations(developer, options));
    recs.push(...this.getClaudeMdRecommendations());
    recs.push(...this.getModelRecommendations());

    // Deduplicate by id
    const seen = new Set<string>();
    const deduped: Recommendation[] = [];
    for (const rec of recs) {
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        deduped.push(rec);
      }
    }

    // Sort by priority
    deduped.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

    if (options?.topN != null && options.topN > 0) {
      return deduped.slice(0, options.topN);
    }

    logger.debug('Recommendations generated', {
      developer,
      total: deduped.length,
    });

    return deduped;
  }

  /**
   * Team-level recommendations aggregating patterns across developers.
   * Like the per-developer collectors below, the thresholds here are
   * hand-picked judgment calls, not derived from data.
   */
  generateTeamRecommendations(options?: { since?: Date }): Recommendation[] {
    const recs: Recommendation[] = [];
    const baseline = this.collaborationProfiler.computeTeamBaseline(options);

    // High team-wide correction rate
    const teamCorrectionPct = round((1 - baseline.dimensions.correctionRate) * 100, 0);
    if (teamCorrectionPct > 30) {
      recs.push(
        makeRec(
          'efficiency',
          'high',
          'High team correction rate',
          'The team average correction rate is high. Consider improving initial prompt context across the team.',
          `Team correction rate: ${teamCorrectionPct}%`,
        ),
      );
    }

    // Low team autonomy
    if (baseline.dimensions.autonomy < 0.5) {
      recs.push(
        makeRec(
          'prompt_engineering',
          'medium',
          'Low team autonomy',
          'The team has low autonomy scores. Consider team-wide adoption of /plan mode for complex tasks.',
          `Team autonomy: ${round(baseline.dimensions.autonomy, 2)}`,
        ),
      );
    }

    return recs;
  }

  /**
   * Emit recommendation metrics to New Relic.
   */
  emitMetrics(aggregator: MetricAggregator, developer: string, options?: { since?: Date }): void {
    const recs = this.generateAllRecommendations(developer, options);

    for (const rec of recs) {
      aggregator.record('ai.recommendation', 1, {
        developer,
        category: rec.category,
        priority: rec.priority,
      });
    }

    logger.debug('Recommendation metrics emitted', {
      developer,
      count: recs.length,
    });
  }

  // -------------------------------------------------------------------------
  // Sub-analyzer recommendation collectors
  //
  // Each method below gates its recommendation behind a hand-picked numeric
  // threshold (waste ratio, cost delta, efficiency drop, etc.) — these are
  // heuristic judgment calls about what's worth surfacing to a developer,
  // not thresholds derived from data. Tune them here if they fire too often
  // or too rarely in practice.
  // -------------------------------------------------------------------------

  private getCostRecommendations(
    _developer: string,
    _options?: { since?: Date },
  ): Recommendation[] {
    const recs: Recommendation[] = [];
    const completed = this.taskDetector?.getCompletedTasks() ?? [];
    const current = this.taskDetector?.getCurrentTask();
    const tasks = current ? [...completed, current] : completed;

    if (tasks.length === 0) return recs;

    const attribution = this.costPerOutcomeAnalyzer.attributeCosts(tasks);

    // High waste ratio
    if (attribution.wasteRatio > 0.2) {
      const wastePct = round(attribution.wasteRatio * 100, 0);
      recs.push(
        makeRec(
          'cost_optimization',
          'high',
          'High failed attempt ratio',
          'Failed attempts represent a significant portion of spend. Consider breaking complex tasks into smaller steps.',
          `Failed attempts: ${wastePct}% of total cost ($${round(attribution.costPerFailedAttempt, 2)} avg per failed attempt)`,
          `Reducing failed attempts by half could save ~$${round((attribution.costPerFailedAttempt * (attribution.outcomeDistribution['failed_attempt']?.count ?? 0)) / 2, 2)}`,
        ),
      );
    }

    // Expensive investigations
    if (attribution.costPerInvestigation > 2) {
      recs.push(
        makeRec(
          'cost_optimization',
          'medium',
          'Expensive investigation tasks',
          'Investigation tasks cost more than expected. Consider using Grep/Glob before asking AI to explore.',
          `Investigation tasks cost $${round(attribution.costPerInvestigation, 2)} avg`,
        ),
      );
    }

    return recs;
  }

  private getEfficiencyRecommendations(
    developer: string,
    options?: { since?: Date },
  ): Recommendation[] {
    const recs: Recommendation[] = [];
    const trends = this.trendAnalyzer.computeTrends({
      since: options?.since,
      developer,
    });

    const effTrend = trends.weeklyEfficiencyTrend;
    if (effTrend.length >= 2) {
      const latest = effTrend[effTrend.length - 1]!;
      const previous = effTrend[effTrend.length - 2]!;
      const drop = previous.value - latest.value;

      if (drop > 0.1) {
        const dropPct = round(drop * 100, 0);
        recs.push(
          makeRec(
            'efficiency',
            'high',
            'Efficiency score dropped',
            `Your efficiency score dropped ${dropPct}% from ${previous.week} to ${latest.week}. Check for increased anti-patterns.`,
            `Efficiency: ${round(previous.value, 2)} → ${round(latest.value, 2)}`,
          ),
        );
      }
    }

    return recs;
  }

  private getPromptRecommendations(
    developer: string,
    options?: { since?: Date },
  ): Recommendation[] {
    const promptRecs = this.promptFeedbackEngine.generatePromptRecommendations(developer, options);

    return promptRecs.map((pr) =>
      makeRec(
        'prompt_engineering',
        pr.priority,
        PROMPT_RECOMMENDATION_TITLES[pr.category] ?? pr.category,
        pr.message,
        pr.evidence,
        pr.estimatedImpact,
        pr.category,
      ),
    );
  }

  private getClaudeMdRecommendations(): Recommendation[] {
    const recs: Recommendation[] = [];
    const changes = this.claudeMdTracker.getChanges();

    if (changes.length > 0) {
      const latestChange = changes[changes.length - 1]!;
      const impact = this.claudeMdTracker.computeImpact(latestChange.timestamp);

      if (impact.verdict.startsWith('Negative')) {
        recs.push(
          makeRec(
            'claudemd',
            'high',
            'Negative CLAUDE.md impact',
            'Recent CLAUDE.md change degraded metrics. Consider reverting or refining the changes.',
            `${impact.verdict}. Efficiency delta: ${impact.deltas.efficiencyScore?.percentChange ?? 'N/A'}%`,
          ),
        );
      }

      if (impact.contextTokensForClaudeMd !== null && impact.contextTokensForClaudeMd > 3000) {
        recs.push(
          makeRec(
            'claudemd',
            'medium',
            'Large CLAUDE.md context cost',
            `CLAUDE.md consumes ~${impact.contextTokensForClaudeMd} tokens per turn. Consider condensing rarely-used sections.`,
            `${impact.contextTokensForClaudeMd} tokens/turn`,
          ),
        );
      }
    }

    return recs;
  }

  private getModelRecommendations(): Recommendation[] {
    const recs: Recommendation[] = [];
    const report = this.trendAnalyzer.rankModelsByOutcome();

    if (report.confidence !== 'high' || report.recommendedModel === null) {
      return recs;
    }

    const currentModel = this.modelUsageTracker?.getMetrics().mostUsedModel ?? null;
    if (currentModel === null || currentModel === report.recommendedModel) {
      return recs;
    }

    const top = report.ranked.find((m) => m.model === report.recommendedModel);
    const current = report.ranked.find((m) => m.model === currentModel);
    if (!top) return recs;

    recs.push(
      makeRec(
        'model_selection',
        'high',
        'Historically better-performing model available',
        `Across ${top.sessionCount} past sessions, ${report.recommendedModel} averaged a higher efficiency score than your current default (${currentModel}). Consider switching.`,
        `${report.recommendedModel}: avg efficiency ${top.avgEfficiencyScore ?? 'n/a'}, $${top.avgCostUsd}/session (n=${top.sessionCount})` +
          (current
            ? `; ${currentModel}: avg efficiency ${current.avgEfficiencyScore ?? 'n/a'}, $${current.avgCostUsd}/session (n=${current.sessionCount})`
            : `; ${currentModel}: no scored sessions yet`),
      ),
    );

    return recs;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRec(
  category: string,
  priority: 'high' | 'medium' | 'low',
  title: string,
  detail: string,
  evidence: string,
  estimatedSavings?: string,
  subCategory?: string,
): Recommendation {
  const hash = createHash('sha256').update(`${category}:${title}`).digest('hex').slice(0, 12);

  return {
    id: `rec-${category}-${hash}`,
    category,
    priority,
    title,
    detail,
    evidence,
    ...(estimatedSavings != null && { estimatedSavings }),
    ...(subCategory != null && { subCategory }),
  };
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
