/**
 * Cost-Per-Outcome Analysis — classifies AI coding tasks by outcome type,
 * computes cost attribution per outcome category, and estimates ROI.
 *
 * Outcome types:
 *   - bug_fix: test failed → edit → test passed
 *   - feature: new files created via Write
 *   - refactor: existing files modified, no test regressions
 *   - investigation: mostly Read/Grep/Glob calls
 *   - configuration: only config file edits (.json, .yaml, etc.)
 *   - documentation: only .md file edits
 *   - failed_attempt: tests failed and never recovered
 */

import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
import type { AiCodingTask } from './task-detector.js';

const logger = createLogger('cost-per-outcome');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeType =
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'investigation'
  | 'configuration'
  | 'documentation'
  | 'failed_attempt';

export interface OutcomeDistribution {
  [outcome: string]: { count: number; totalCost: number; avgCost: number };
}

export interface CostAttribution {
  readonly outcomeDistribution: OutcomeDistribution;
  readonly costPerBugFix: number;
  readonly costPerFeature: number;
  readonly costPerRefactor: number;
  readonly costPerInvestigation: number;
  readonly costPerConfiguration: number;
  readonly costPerDocumentation: number;
  readonly costPerFailedAttempt: number;
  readonly wasteRatio: number;
  readonly totalCost: number;
  readonly totalTasks: number;
}

export interface RoiEstimate {
  readonly totalAiCost: number;
  readonly estimatedHoursSaved: number;
  readonly estimatedValueUsd: number;
  readonly roi: number;
  readonly byOutcome: Record<string, { count: number; hoursSaved: number; valueUsd: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Rough, deliberately conservative estimates of developer hours an AI-assisted
// task of this outcome type would otherwise take by hand — there's no way to
// measure this directly, so ROI figures derived from it are an approximation,
// not a precise measurement. Callers can override via the constructor.
const DEFAULT_HOURS_SAVED: Record<OutcomeType, number> = {
  bug_fix: 2,
  feature: 4,
  refactor: 1.5,
  investigation: 0.5,
  configuration: 0.5,
  documentation: 1,
  failed_attempt: 0,
};

const CONFIG_EXTENSIONS = /\.(json|yaml|yml|toml|env|ini)$/i;
const DOC_EXTENSIONS = /\.md$/i;

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// ---------------------------------------------------------------------------
// CostPerOutcomeAnalyzer
// ---------------------------------------------------------------------------

export class CostPerOutcomeAnalyzer {
  private readonly hoursSaved: Record<OutcomeType, number>;

  constructor(options?: { hoursSaved?: Partial<Record<OutcomeType, number>> }) {
    this.hoursSaved = { ...DEFAULT_HOURS_SAVED, ...options?.hoursSaved };
  }

  /**
   * Classify a task by its outcome type using a priority-based rule set
   * that inspects the tool call sequence.
   */
  classifyOutcome(task: AiCodingTask): OutcomeType {
    const toolCalls = task.toolCalls;

    let hasTestFailure = false;
    let hasTestPassAfterEdit = false;
    let hasWriteNewFile = false;
    let sawEditAfterFailure = false;

    for (const tc of toolCalls) {
      if (tc.isTestCommand === true) {
        if (tc.success === false) {
          hasTestFailure = true;
        } else if (tc.success === true && hasTestFailure && sawEditAfterFailure) {
          hasTestPassAfterEdit = true;
        }
      }

      if ((tc.toolName === 'Edit' || tc.toolName === 'Write') && hasTestFailure) {
        sawEditAfterFailure = true;
      }

      if (tc.toolName === 'Write') {
        hasWriteNewFile = true;
      }
    }

    // Priority 1: failed_attempt — tests failed and never recovered.
    // Exclude tasks that also created new files; those are better classified
    // as feature/refactor attempts that happen to have failing tests.
    if (hasTestFailure && !hasTestPassAfterEdit && !hasWriteNewFile) {
      return 'failed_attempt';
    }

    // Priority 2: bug_fix — test fail → edit → test pass
    if (hasTestFailure && hasTestPassAfterEdit) {
      return 'bug_fix';
    }

    // Priority 3: feature — new files created
    if (hasWriteNewFile) {
      return 'feature';
    }

    // Priority 4: configuration — only config files modified
    const modifiedFiles = task.filesModified;
    if (modifiedFiles.length > 0 && modifiedFiles.every((f) => CONFIG_EXTENSIONS.test(f))) {
      return 'configuration';
    }

    // Priority 5: documentation — only .md files modified
    if (modifiedFiles.length > 0 && modifiedFiles.every((f) => DOC_EXTENSIONS.test(f))) {
      return 'documentation';
    }

    // Priority 6: refactor — files modified, no test regressions
    if (modifiedFiles.length > 0) {
      return 'refactor';
    }

    // Priority 7: investigation — mostly read/search tools
    if (task.toolCallCount > 0) {
      const readCount = toolCalls.filter((tc) => READ_TOOLS.has(tc.toolName)).length;
      if (readCount / task.toolCallCount >= 0.8) {
        return 'investigation';
      }
    }

    // Default
    return 'feature';
  }

  /**
   * Attribute costs across tasks by outcome category.
   */
  attributeCosts(tasks: AiCodingTask[]): CostAttribution {
    const distribution: OutcomeDistribution = {};
    let totalCost = 0;

    for (const task of tasks) {
      const outcome = this.classifyOutcome(task);
      const cost = task.estimatedCostUsd ?? 0;
      totalCost += cost;

      if (!distribution[outcome]) {
        distribution[outcome] = { count: 0, totalCost: 0, avgCost: 0 };
      }
      distribution[outcome].count++;
      distribution[outcome].totalCost += cost;
    }

    // Compute averages
    for (const entry of Object.values(distribution)) {
      entry.avgCost = entry.count > 0 ? round(entry.totalCost / entry.count, 4) : 0;
      entry.totalCost = round(entry.totalCost, 4);
    }

    const avgCostFor = (outcome: string): number => distribution[outcome]?.avgCost ?? 0;

    const failedCost = distribution['failed_attempt']?.totalCost ?? 0;
    const wasteRatio = totalCost > 0 ? round(failedCost / totalCost, 4) : 0;

    return {
      outcomeDistribution: distribution,
      costPerBugFix: avgCostFor('bug_fix'),
      costPerFeature: avgCostFor('feature'),
      costPerRefactor: avgCostFor('refactor'),
      costPerInvestigation: avgCostFor('investigation'),
      costPerConfiguration: avgCostFor('configuration'),
      costPerDocumentation: avgCostFor('documentation'),
      costPerFailedAttempt: avgCostFor('failed_attempt'),
      wasteRatio,
      totalCost: round(totalCost, 4),
      totalTasks: tasks.length,
    };
  }

  /**
   * Estimate ROI by multiplying task counts by hours-saved estimates
   * and the developer's hourly cost.
   */
  estimateROI(attribution: CostAttribution, developerHourlyCost: number): RoiEstimate {
    let totalHoursSaved = 0;
    let totalValue = 0;
    const byOutcome: Record<string, { count: number; hoursSaved: number; valueUsd: number }> = {};

    for (const [outcome, entry] of Object.entries(attribution.outcomeDistribution)) {
      const hours = (this.hoursSaved[outcome as OutcomeType] ?? 0) * entry.count;
      const value = hours * developerHourlyCost;
      totalHoursSaved += hours;
      totalValue += value;

      byOutcome[outcome] = {
        count: entry.count,
        hoursSaved: round(hours, 2),
        valueUsd: round(value, 2),
      };
    }

    const roi = round(totalValue - attribution.totalCost, 2);

    return {
      totalAiCost: attribution.totalCost,
      estimatedHoursSaved: round(totalHoursSaved, 2),
      estimatedValueUsd: round(totalValue, 2),
      roi,
      byOutcome,
    };
  }

  emitMetrics(aggregator: MetricAggregator, tasks: AiCodingTask[], developer: string): void {
    const attribution = this.attributeCosts(tasks);

    // Per-task outcome events
    for (const task of tasks) {
      const outcome = this.classifyOutcome(task);
      aggregator.record('ai.task.outcome', 1, {
        developer,
        outcome,
        costUsd: task.estimatedCostUsd ?? 0,
        toolCalls: task.toolCallCount,
      });
    }

    // Per-category cost summaries
    for (const [outcome, entry] of Object.entries(attribution.outcomeDistribution)) {
      aggregator.record('ai.cost_per_outcome', entry.avgCost, {
        developer,
        outcome,
        count: entry.count,
        totalCost: entry.totalCost,
      });
    }

    logger.debug('Cost-per-outcome metrics emitted', {
      developer,
      taskCount: tasks.length,
      categories: Object.keys(attribution.outcomeDistribution).length,
    });
  }
}

// ---------------------------------------------------------------------------
// Session-level classification (for History view)
// ---------------------------------------------------------------------------

/**
 * Subset of FullSessionSummary fields needed to bucket a stored session into
 * an outcome category. Used by the History view so we can render a
 * cost-per-outcome breakdown across persisted sessions without retaining the
 * raw per-task tool-call sequence on disk.
 *
 * The heuristic mirrors classifyOutcome's priority order but uses session
 * aggregates: it cannot detect intra-session "test fail → edit → test pass"
 * flow precisely, so a passing test with edits is treated as bug_fix.
 */
export interface SessionOutcomeInputs {
  readonly testRunCount: number;
  readonly testPassCount: number;
  readonly filesModified: readonly string[];
  readonly toolBreakdown: Record<string, number>;
  readonly toolCallCount: number;
}

export function classifySessionOutcome(s: SessionOutcomeInputs): OutcomeType {
  // Mirrors classifyOutcome's priority order (see its own per-branch
  // comments above for the full rationale), adapted to session-level
  // aggregates instead of a per-task tool-call sequence.

  // Priority 1: failed_attempt — tests ran and never passed.
  if (s.testRunCount > 0 && s.testPassCount === 0) return 'failed_attempt';
  // Priority 2: bug_fix — tests ran and passed, with files modified. Can't
  // detect the precise "fail → edit → pass" ordering from aggregates alone
  // (see SessionOutcomeInputs doc above), so any passing-test session with
  // edits is treated as bug_fix.
  if (s.testRunCount > 0 && s.testPassCount > 0 && s.filesModified.length > 0) return 'bug_fix';

  // Priority 3: feature — new files created.
  const writeCount = s.toolBreakdown['Write'] ?? 0;
  if (writeCount >= 1 && s.filesModified.length > 0) return 'feature';

  // Priority 4: configuration — only config files modified.
  if (s.filesModified.length > 0 && s.filesModified.every((f) => CONFIG_EXTENSIONS.test(f))) {
    return 'configuration';
  }
  // Priority 5: documentation — only .md files modified.
  if (s.filesModified.length > 0 && s.filesModified.every((f) => DOC_EXTENSIONS.test(f))) {
    return 'documentation';
  }
  // Priority 6: refactor — files modified, no test regressions.
  if (s.filesModified.length > 0) return 'refactor';

  // Priority 7: investigation — mostly read/search tools.
  if (s.toolCallCount > 0) {
    const readCount =
      (s.toolBreakdown['Read'] ?? 0) +
      (s.toolBreakdown['Grep'] ?? 0) +
      (s.toolBreakdown['Glob'] ?? 0);
    if (readCount / s.toolCallCount >= 0.8) return 'investigation';
  }

  // Default
  return 'feature';
}

export interface SessionLikeForCostOutcome extends SessionOutcomeInputs {
  readonly estimatedCostUsd: number | null;
}

export function attributeSessionCosts(
  sessions: readonly SessionLikeForCostOutcome[],
): CostAttribution {
  const distribution: OutcomeDistribution = {};
  let totalCost = 0;

  for (const s of sessions) {
    const outcome = classifySessionOutcome(s);
    const cost = s.estimatedCostUsd ?? 0;
    totalCost += cost;
    if (!distribution[outcome]) {
      distribution[outcome] = { count: 0, totalCost: 0, avgCost: 0 };
    }
    distribution[outcome].count++;
    distribution[outcome].totalCost += cost;
  }

  for (const entry of Object.values(distribution)) {
    entry.avgCost = entry.count > 0 ? round(entry.totalCost / entry.count, 4) : 0;
    entry.totalCost = round(entry.totalCost, 4);
  }

  const avgCostFor = (outcome: string): number => distribution[outcome]?.avgCost ?? 0;
  const failedCost = distribution['failed_attempt']?.totalCost ?? 0;
  const wasteRatio = totalCost > 0 ? round(failedCost / totalCost, 4) : 0;

  return {
    outcomeDistribution: distribution,
    costPerBugFix: avgCostFor('bug_fix'),
    costPerFeature: avgCostFor('feature'),
    costPerRefactor: avgCostFor('refactor'),
    costPerInvestigation: avgCostFor('investigation'),
    costPerConfiguration: avgCostFor('configuration'),
    costPerDocumentation: avgCostFor('documentation'),
    costPerFailedAttempt: avgCostFor('failed_attempt'),
    wasteRatio,
    totalCost: round(totalCost, 4),
    totalTasks: sessions.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
