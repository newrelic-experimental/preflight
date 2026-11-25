import { savedToolNameByUseId, type FullSessionSummary } from '../storage/session-store.js';
import { buildCostTrackerSeed, unbookedSeedCostOf } from './cost-tracker-seed.js';
import type { UnbookedSeedCost } from './cost-tracker-seed.js';
import type { CostTrackerSeed } from './cost-tracker.js';
import type { ModelBreakdownEntry } from './model-usage-tracker.js';
import type { EfficiencyScoreSeed } from './efficiency-score.js';
import type { QualityProxyRawCounts } from './quality-proxy-tracker.js';
import type { SessionTrackerSeed } from './session-tracker.js';
import type { TaskDetectorSeed } from './task-detector.js';
import { buildTaskDetectorSeed } from './task-detector-seed.js';

/** What SessionTracker, QualityProxyTracker, TaskDetector and EfficiencyScorer seed from. */
export interface ToolCallSeed {
  readonly sessionTracker: SessionTrackerSeed;
  readonly qualityProxy: QualityProxyRawCounts;
  readonly taskDetector: TaskDetectorSeed;
  readonly efficiency: EfficiencyScoreSeed | null;
}

export function toolCallSeedOf(summary: FullSessionSummary): ToolCallSeed {
  const sampleCount = summary.efficiencyScoreSampleCount ?? 0;
  return {
    sessionTracker: {
      sessionId: summary.sessionId,
      toolCallCount: summary.toolCallCount,
      bashCommandCount: summary.bashCommandCount,
      toolNameByUseId: savedToolNameByUseId(summary),
    },
    qualityProxy: summary.qualityProxy,
    taskDetector: buildTaskDetectorSeed(summary),
    efficiency:
      summary.efficiencyScore !== null && summary.efficiencyScoreComponents && sampleCount > 0
        ? {
            score: summary.efficiencyScore,
            components: summary.efficiencyScoreComponents,
            sampleCount,
          }
        : null,
  };
}

/** What CostTracker, ModelUsageTracker and the budget thresholds seed from. */
export interface CostSeed {
  readonly costTracker: CostTrackerSeed;
  readonly modelBreakdown: Readonly<Record<string, ModelBreakdownEntry>>;
  /** The prior spend alone, which is all the budget thresholds may be seeded from. */
  readonly estimatedCostUsd: number | null;
  /** What the budget windows by day on top of the seeded CostTracker. */
  readonly unbooked: UnbookedSeedCost;
}

export function costSeedOf(summary: FullSessionSummary): CostSeed {
  const costTracker = buildCostTrackerSeed(summary);
  return {
    costTracker,
    modelBreakdown: summary.modelBreakdown,
    estimatedCostUsd: summary.estimatedCostUsd,
    unbooked: unbookedSeedCostOf(summary, costTracker),
  };
}

/** The session file each tracker family seeds from; null seeds nothing. */
export interface RehydrationSeeds {
  readonly toolCalls: ToolCallSeed | null;
  /** For CostTracker, ModelUsageTracker and the budget thresholds. */
  readonly cost: CostSeed | null;
}

/**
 * Seeding adds, so each tracker family of a --stdio engine must seed a
 * session from its file as it stood before this process saved anything that
 * family already counted. The tool-call trackers count every record of the
 * session the process drained, even one drained before it adopted the id, and
 * a provisional rollup saves those records too, so their snapshot is taken at
 * the first save of any kind. The cost trackers only price another session's
 * tokens, so theirs is taken at the first save of the process's own summary;
 * until then they seed from the current file, which holds the rollup cost they
 * never counted. Once they are given that rollup cost too (countRollupCost),
 * theirs is the tool-call trackers' snapshot.
 *
 * Entries stay until their id is rehydrated. A provisional engine keeps the
 * file it first saved over for each session it rolls up, next to the full
 * rollup (timeline included) LocalSessionAggregator already keeps for that
 * session for the life of the process. Evicting one would bring the double
 * count back. Only the cwd-guessed id ever has an own-summary snapshot.
 */
export class FirstSaveBaselines {
  private readonly beforeAnySave = new Map<string, FullSessionSummary | null>();
  private readonly beforeOwnSave = new Map<string, FullSessionSummary | null>();
  private readonly rollupCostCounted = new Set<string>();

  /** `previous` is the file the save merged against, null for a new file. */
  recordSave(save: {
    readonly sessionId: string;
    readonly previous: FullSessionSummary | null;
    readonly ownSession: boolean;
  }): void {
    const { sessionId, previous, ownSession } = save;
    if (!this.beforeAnySave.has(sessionId)) this.beforeAnySave.set(sessionId, previous);
    if (ownSession && !this.beforeOwnSave.has(sessionId)) {
      this.beforeOwnSave.set(sessionId, previous);
    }
  }

  /** The cost trackers now count every save of `sessionId` this process made, rollups included. */
  countRollupCost(sessionId: string): void {
    this.rollupCostCounted.add(sessionId);
  }

  /**
   * The file `sessionId`'s cost seed will come from: the file before this
   * process first saved anything its cost trackers count (null for a new
   * file), or undefined when it has saved nothing of the kind and the current
   * file still holds none of their cost.
   */
  costSeedFile(sessionId: string): FullSessionSummary | null | undefined {
    return this.costFiles(sessionId).get(sessionId);
  }

  /** Seeds for `sessionId`, falling back to `loadCurrent()` per family, and forgets it. */
  take(sessionId: string, loadCurrent: () => FullSessionSummary | null): RehydrationSeeds {
    const costFiles = this.costFiles(sessionId);
    const current =
      this.beforeAnySave.has(sessionId) && costFiles.has(sessionId) ? null : loadCurrent();
    const toolCallFile = this.beforeAnySave.has(sessionId)
      ? (this.beforeAnySave.get(sessionId) ?? null)
      : current;
    const costFile = costFiles.has(sessionId) ? (costFiles.get(sessionId) ?? null) : current;
    this.beforeAnySave.delete(sessionId);
    this.beforeOwnSave.delete(sessionId);
    this.rollupCostCounted.delete(sessionId);
    return {
      toolCalls: toolCallFile && toolCallSeedOf(toolCallFile),
      cost: costFile && costSeedOf(costFile),
    };
  }

  private costFiles(sessionId: string): ReadonlyMap<string, FullSessionSummary | null> {
    return this.rollupCostCounted.has(sessionId) ? this.beforeAnySave : this.beforeOwnSave;
  }
}
