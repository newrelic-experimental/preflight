import type { SkillStamp } from '../storage/types.js';

import type { SkillRunOpenContext } from './skill-activation-tracker.js';
import type { ClosedSkillRun } from './skill-run-ledger.js';
import { isTokenEventForThisProcess } from './cost-estimate-gate.js';

export interface SkillRunSink {
  ingestSkillRun(
    stamp: SkillStamp,
    context: { timestamp: number; sessionId: string | null; platform?: string },
  ): void;
  ingestWorkUnit(run: ClosedSkillRun): void;
}

export interface SkillRunEmitterOptions {
  readonly stdio: boolean;
  readonly getOwnSessionId: () => string;
  readonly getSink: () => SkillRunSink | undefined;
}

/**
 * Applies the same own-session rule as `AiTurnCost`: a `--stdio` engine
 * drains other sessions' records while its own id is still provisional.
 */
function isOwnRun(options: SkillRunEmitterOptions, sessionId: string | null): boolean {
  return isTokenEventForThisProcess({
    stdio: options.stdio,
    eventSessionId: sessionId,
    ownSessionId: options.getOwnSessionId(),
  });
}

/** Builds the `SkillActivationTracker` `onRunOpened` callback. */
export function createSkillRunEmitter(
  options: SkillRunEmitterOptions,
): (stamp: SkillStamp, ctx: SkillRunOpenContext) => void {
  return (stamp, ctx) => {
    if (!isOwnRun(options, ctx.sessionId)) return;
    options.getSink()?.ingestSkillRun(stamp, {
      timestamp: ctx.timestamp ?? Date.now(),
      sessionId: ctx.sessionId,
      platform: ctx.platform,
    });
  };
}

/** Builds the `SkillRunLedger` callback that sends each closed run as `AiWorkUnit`. */
export function createWorkUnitEmitter(
  options: SkillRunEmitterOptions,
): (run: ClosedSkillRun) => void {
  return (run) => {
    if (isOwnRun(options, run.sessionId)) options.getSink()?.ingestWorkUnit(run);
  };
}
