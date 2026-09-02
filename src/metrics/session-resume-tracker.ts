/**
 * Session Resume Cost Tracking — records what Claude Code's own SessionStart
 * hook reported about resuming a stale conversation: how long it had been
 * since the last response, and Claude Code's own estimate of what re-caching
 * the conversation will cost. Feeds CostForecastTracker's forecast tool so a
 * resume-driven cost spike has an explanation attached instead of showing up
 * as an unexplained cache-hit dip after the fact.
 *
 * Only ever fed for `source: 'resume'`/`'fork'` SessionStart events that
 * carry the resume-cost fields — a plain 'startup'/'clear'/'compact' start
 * has nothing to report, and `recordResume()` is simply never called for
 * those (see the `onSessionStart` callback wiring in index.ts).
 */
import type { Resettable } from './tracker-contracts.js';

export interface SessionResumeEvent {
  readonly timestamp: number;
  readonly secondsSinceLastResponse: number;
  readonly contextTokens: number;
  readonly promptCacheLikelyExpired: boolean;
  readonly estimatedCacheWriteUsd: number;
}

export interface SessionResumeMetrics {
  readonly resumeCount: number;
  /** Sum of estimatedCacheWriteUsd across every resume this tracker has seen. */
  readonly totalEstimatedCacheWriteUsd: number;
  readonly lastResume: SessionResumeEvent | null;
}

export class SessionResumeTracker implements Resettable {
  private resumeCount = 0;
  private totalEstimatedCacheWriteUsd = 0;
  private lastResume: SessionResumeEvent | null = null;

  recordResume(event: {
    secondsSinceLastResponse: number;
    contextTokens: number;
    promptCacheLikelyExpired: boolean;
    estimatedCacheWriteUsd: number;
    timestampMs?: number;
  }): void {
    const resume: SessionResumeEvent = {
      timestamp: event.timestampMs ?? Date.now(),
      secondsSinceLastResponse: event.secondsSinceLastResponse,
      contextTokens: event.contextTokens,
      promptCacheLikelyExpired: event.promptCacheLikelyExpired,
      estimatedCacheWriteUsd: event.estimatedCacheWriteUsd,
    };
    this.resumeCount++;
    this.totalEstimatedCacheWriteUsd += event.estimatedCacheWriteUsd;
    this.lastResume = resume;
  }

  getMetrics(): SessionResumeMetrics {
    return {
      resumeCount: this.resumeCount,
      totalEstimatedCacheWriteUsd: this.totalEstimatedCacheWriteUsd,
      lastResume: this.lastResume,
    };
  }

  reset(_sessionId: string): void {
    this.resumeCount = 0;
    this.totalEstimatedCacheWriteUsd = 0;
    this.lastResume = null;
  }
}
