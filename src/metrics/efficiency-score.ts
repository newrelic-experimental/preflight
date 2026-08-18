/**
 * AI Coding Efficiency Score — computes a composite score for completed tasks.
 *
 * The score is a weighted average of four components, each in [0, 1]:
 *   1. Speed:                linesChanged / taskDuration, normalized to 1 line/s = 1.0
 *   2. Correctness:          test pass rate during the task (0.5 default if no tests)
 *   3. Autonomy:             1 - (userQuestions / toolCalls)
 *   4. First-attempt quality: 1 - (thrashIterations / 3), floored at 0
 *
 * Final score = weighted average, clamped to [0, 1].
 */

import type { MetricAggregator } from '../shared/index.js';
import type { AiCodingTask } from './task-detector.js';
import type { AntiPattern } from './anti-patterns.js';
import type { Resettable } from './tracker-contracts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EfficiencyScoreComponents {
  readonly speed: number;
  readonly correctness: number;
  readonly autonomy: number;
  readonly firstAttemptQuality: number;
}

export interface EfficiencyScore {
  readonly score: number;
  readonly components: EfficiencyScoreComponents;
  readonly taskId: string;
  readonly timestamp: number;
}

export interface EfficiencyScoreOptions {
  readonly speedWeight?: number;
  readonly correctnessWeight?: number;
  readonly autonomyWeight?: number;
  readonly firstAttemptQualityWeight?: number;
  readonly speedBaselineLinesPerSecond?: number;
}

/**
 * Input shape for `EfficiencyScorer.seedFromPersisted()` — a previous
 * process's last checkpoint of `getSessionAverage()` for this same session,
 * built directly from `FullSessionSummary.efficiencyScore` +
 * `.efficiencyScoreComponents` + `.efficiencyScoreSampleCount`
 * (session-store.ts).
 */
export interface EfficiencyScoreSeed {
  readonly score: number;
  readonly components: EfficiencyScoreComponents;
  readonly sampleCount: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SPEED_WEIGHT = 0.25;
const DEFAULT_CORRECTNESS_WEIGHT = 0.25;
const DEFAULT_AUTONOMY_WEIGHT = 0.25;
const DEFAULT_FIRST_ATTEMPT_QUALITY_WEIGHT = 0.25;
const DEFAULT_SPEED_BASELINE_LPS = 1; // 1 line per second = perfect speed

const MAX_SCORES = 1_000;

// ---------------------------------------------------------------------------
// EfficiencyScorer
// ---------------------------------------------------------------------------

export class EfficiencyScorer implements Resettable {
  private readonly speedWeight: number;
  private readonly correctnessWeight: number;
  private readonly autonomyWeight: number;
  private readonly firstAttemptQualityWeight: number;
  private readonly speedBaselineLps: number;

  private readonly scores: EfficiencyScore[] = [];
  private lastEmittedIndex = 0;

  // Weighted seed from a previous process's last checkpoint for this same
  // session — see seedFromPersisted()'s doc comment. The persisted
  // checkpoint is already itself an average (not raw per-task scores), so
  // seeding accumulates a weighted contribution (value * sampleCount) rather
  // than raw per-task totals like CostTracker.seedFromPersisted() does.
  private seededScoreSum = 0;
  private seededSpeedSum = 0;
  private seededCorrectnessSum = 0;
  private seededAutonomySum = 0;
  private seededFirstAttemptSum = 0;
  private seededSampleCount = 0;

  constructor(options?: EfficiencyScoreOptions) {
    this.speedWeight = options?.speedWeight ?? DEFAULT_SPEED_WEIGHT;
    this.correctnessWeight = options?.correctnessWeight ?? DEFAULT_CORRECTNESS_WEIGHT;
    this.autonomyWeight = options?.autonomyWeight ?? DEFAULT_AUTONOMY_WEIGHT;
    this.firstAttemptQualityWeight =
      options?.firstAttemptQualityWeight ?? DEFAULT_FIRST_ATTEMPT_QUALITY_WEIGHT;
    this.speedBaselineLps = options?.speedBaselineLinesPerSecond ?? DEFAULT_SPEED_BASELINE_LPS;
  }

  /**
   * Compute the efficiency score for a completed task.
   * Anti-patterns are optional — if not provided, first-attempt quality defaults to 1.0.
   */
  computeScore(task: AiCodingTask, antiPatterns?: AntiPattern[]): EfficiencyScore {
    const components = this.computeComponents(task, antiPatterns);
    const raw =
      components.speed * this.speedWeight +
      components.correctness * this.correctnessWeight +
      components.autonomy * this.autonomyWeight +
      components.firstAttemptQuality * this.firstAttemptQualityWeight;

    const score = clamp(Math.round(raw * 1000) / 1000, 0, 1);

    const result: EfficiencyScore = {
      score,
      components,
      taskId: task.taskId,
      timestamp: task.endTime,
    };

    const idx = this.scores.findIndex((s) => s.taskId === task.taskId);
    if (idx >= 0) {
      this.scores[idx] = result;
    } else {
      this.appendScore(result);
    }

    return result;
  }

  /**
   * Seeds a weighted contribution to the session average from a previous
   * process's last checkpoint for this same session — same restart-recovery
   * problem as `CostTracker.seedFromPersisted()`/`ModelUsageTracker.seedFromPersisted()`,
   * but adapted for a tracker whose own persisted checkpoint is already an
   * average rather than raw per-task data — the per-task score list isn't
   * reconstructable from a checkpoint, only the average is.
   *
   * Adds to current totals rather than overwriting, so callers must invoke
   * this at most once per (re)adopted session id, before any real activity
   * for that id has reached this tracker.
   */
  seedFromPersisted(seed: EfficiencyScoreSeed): void {
    if (seed.sampleCount <= 0) return;
    this.seededScoreSum += seed.score * seed.sampleCount;
    this.seededSpeedSum += seed.components.speed * seed.sampleCount;
    this.seededCorrectnessSum += seed.components.correctness * seed.sampleCount;
    this.seededAutonomySum += seed.components.autonomy * seed.sampleCount;
    this.seededFirstAttemptSum += seed.components.firstAttemptQuality * seed.sampleCount;
    this.seededSampleCount += seed.sampleCount;
  }

  /**
   * Session-wide rolling average across all scored tasks.
   */
  getSessionAverage(): EfficiencyScore | null {
    const n = this.scores.length + this.seededSampleCount;
    if (n === 0) return null;

    let totalScore = this.seededScoreSum;
    let totalSpeed = this.seededSpeedSum;
    let totalCorrectness = this.seededCorrectnessSum;
    let totalAutonomy = this.seededAutonomySum;
    let totalFirstAttempt = this.seededFirstAttemptSum;

    for (const s of this.scores) {
      totalScore += s.score;
      totalSpeed += s.components.speed;
      totalCorrectness += s.components.correctness;
      totalAutonomy += s.components.autonomy;
      totalFirstAttempt += s.components.firstAttemptQuality;
    }

    return {
      score: Math.round((totalScore / n) * 1000) / 1000,
      components: {
        speed: Math.round((totalSpeed / n) * 1000) / 1000,
        correctness: Math.round((totalCorrectness / n) * 1000) / 1000,
        autonomy: Math.round((totalAutonomy / n) * 1000) / 1000,
        firstAttemptQuality: Math.round((totalFirstAttempt / n) * 1000) / 1000,
      },
      taskId: 'session-average',
      timestamp: Date.now(),
    };
  }

  /**
   * Effective sample count behind getSessionAverage() — fresh scores plus
   * any seeded weight from a previous process's checkpoint. Distinct from
   * getScores().length, which is fresh-only and would silently drop or
   * under-weight seeded history if used to persist the sample count that
   * pairs with getSessionAverage()'s seed-inclusive score.
   */
  getSessionSampleCount(): number {
    return this.scores.length + this.seededSampleCount;
  }

  /**
   * Recompute and replace the score for a task that may have changed (e.g., active task).
   */
  updateScore(task: AiCodingTask, antiPatterns?: AntiPattern[]): EfficiencyScore {
    const idx = this.scores.findIndex((s) => s.taskId === task.taskId);
    const components = this.computeComponents(task, antiPatterns);
    const raw =
      components.speed * this.speedWeight +
      components.correctness * this.correctnessWeight +
      components.autonomy * this.autonomyWeight +
      components.firstAttemptQuality * this.firstAttemptQualityWeight;

    const score = clamp(Math.round(raw * 1000) / 1000, 0, 1);

    const result: EfficiencyScore = {
      score,
      components,
      taskId: task.taskId,
      timestamp: task.endTime,
    };

    if (idx >= 0) {
      this.scores[idx] = result;
      // Reset emit pointer so the updated score gets re-emitted on the next
      // emitMetrics() call — previously it was silently dropped if already emitted.
      if (idx < this.lastEmittedIndex) {
        this.lastEmittedIndex = idx;
      }
    } else {
      this.appendScore(result);
    }

    return result;
  }

  getScores(): EfficiencyScore[] {
    return [...this.scores];
  }

  emitMetrics(aggregator: MetricAggregator): void {
    for (let i = this.lastEmittedIndex; i < this.scores.length; i++) {
      const s = this.scores[i]!;
      aggregator.record('ai.efficiency.score', s.score);
      aggregator.record('ai.efficiency.speed', s.components.speed);
      aggregator.record('ai.efficiency.correctness', s.components.correctness);
      aggregator.record('ai.efficiency.autonomy', s.components.autonomy);
      aggregator.record('ai.efficiency.first_attempt_quality', s.components.firstAttemptQuality);
    }
    this.lastEmittedIndex = this.scores.length;
  }

  reset(_sessionId: string): void {
    this.scores.length = 0;
    this.lastEmittedIndex = 0;
    this.seededScoreSum = 0;
    this.seededSpeedSum = 0;
    this.seededCorrectnessSum = 0;
    this.seededAutonomySum = 0;
    this.seededFirstAttemptSum = 0;
    this.seededSampleCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private computeComponents(
    task: AiCodingTask,
    antiPatterns?: AntiPattern[],
  ): EfficiencyScoreComponents {
    return {
      speed: this.computeSpeed(task),
      correctness: this.computeCorrectness(task),
      autonomy: this.computeAutonomy(task),
      firstAttemptQuality: this.computeFirstAttemptQuality(antiPatterns),
    };
  }

  /**
   * Speed: linesChanged / durationSeconds, normalized to baseline.
   * 0 lines → 0 speed. 0 duration → clamp to 1.0.
   */
  private computeSpeed(task: AiCodingTask): number {
    if (task.linesChanged === 0) return 0;
    if (task.durationMs <= 0) return 1;

    const durationSeconds = task.durationMs / 1000;
    const linesPerSecond = task.linesChanged / durationSeconds;
    return clamp(linesPerSecond / this.speedBaselineLps, 0, 1);
  }

  /**
   * Correctness: test pass rate. Default 0.5 if no tests were run.
   */
  private computeCorrectness(task: AiCodingTask): number {
    if (task.testsRun === 0) return 0.5;
    return clamp(task.testsPassed / task.testsRun, 0, 1);
  }

  /**
   * Autonomy: 1 - (userQuestions / toolCalls). 1.0 if no questions asked.
   */
  private computeAutonomy(task: AiCodingTask): number {
    if (task.toolCallCount === 0) return 1;
    if (task.askedUserQuestions === 0) return 1;
    return clamp(1 - task.askedUserQuestions / task.toolCallCount, 0, 1);
  }

  /**
   * First-attempt quality: 1 - (maxThrashIterations / 3), floored at 0.
   * If no anti-patterns provided or no thrashing, score is 1.0.
   */
  private computeFirstAttemptQuality(antiPatterns?: AntiPattern[]): number {
    if (!antiPatterns || antiPatterns.length === 0) return 1;

    let maxIterations = 0;
    for (const pattern of antiPatterns) {
      if (pattern.type === 'thrashing' && pattern.iterations != null) {
        maxIterations = Math.max(maxIterations, pattern.iterations);
      }
    }

    if (maxIterations === 0) return 1;
    return clamp(1 - maxIterations / 3, 0, 1);
  }

  private appendScore(score: EfficiencyScore): void {
    this.scores.push(score);
    if (this.scores.length > MAX_SCORES) {
      const dropped = this.scores.length - MAX_SCORES;
      this.scores.splice(0, dropped);
      this.lastEmittedIndex = Math.max(0, this.lastEmittedIndex - dropped);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
