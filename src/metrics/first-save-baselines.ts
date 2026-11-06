import type { FullSessionSummary } from '../storage/session-store.js';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
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
      toolCallCount: summary.toolCallCount,
      bashCommandCount: summary.bashCommandCount,
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
}

export function costSeedOf(summary: FullSessionSummary): CostSeed {
  return {
    costTracker: buildCostTrackerSeed(summary),
    modelBreakdown: summary.modelBreakdown,
    estimatedCostUsd: summary.estimatedCostUsd,
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
 * the first save of any kind. The cost trackers only
 * price another session's tokens, so theirs is taken at the first save of
 * the process's own summary; until then they seed from the current file,
 * which holds the rollup cost they never counted.
 *
 * Entries stay until their id is rehydrated. A provisional engine keeps one
 * small tool-call record per session it rolls up, next to the full rollup
 * (timeline included) LocalSessionAggregator already keeps for that session
 * for the life of the process. Evicting a record would bring the double
 * count back. Only the cwd-guessed id ever has an own-summary snapshot.
 */
export class FirstSaveBaselines {
  private readonly toolCalls = new Map<string, ToolCallSeed | null>();
  private readonly cost = new Map<string, CostSeed | null>();

  /** `previous` is the file the save merged against, null for a new file. */
  recordSave(save: {
    readonly sessionId: string;
    readonly previous: FullSessionSummary | null;
    readonly ownSession: boolean;
  }): void {
    const { sessionId, previous, ownSession } = save;
    if (!this.toolCalls.has(sessionId)) {
      this.toolCalls.set(sessionId, previous && toolCallSeedOf(previous));
    }
    if (ownSession && !this.cost.has(sessionId))
      this.cost.set(sessionId, previous && costSeedOf(previous));
  }

  /** Drops a session id that a correction showed was a wrong guess. */
  forget(sessionId: string): void {
    this.toolCalls.delete(sessionId);
    this.cost.delete(sessionId);
  }

  /** Seeds for `sessionId`, falling back to `loadCurrent()` per family, and forgets it. */
  take(sessionId: string, loadCurrent: () => FullSessionSummary | null): RehydrationSeeds {
    const current =
      this.toolCalls.has(sessionId) && this.cost.has(sessionId) ? null : loadCurrent();
    const seeds: RehydrationSeeds = {
      toolCalls: this.toolCalls.has(sessionId)
        ? (this.toolCalls.get(sessionId) ?? null)
        : current && toolCallSeedOf(current),
      cost: this.cost.has(sessionId)
        ? (this.cost.get(sessionId) ?? null)
        : current && costSeedOf(current),
    };
    this.toolCalls.delete(sessionId);
    this.cost.delete(sessionId);
    return seeds;
  }
}
