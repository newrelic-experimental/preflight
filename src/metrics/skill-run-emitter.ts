import type { SkillStamp } from '../storage/types.js';

import type { SkillRunOpenContext } from './skill-activation-tracker.js';
import { isTokenEventForThisProcess } from './cost-estimate-gate.js';

export interface SkillRunSink {
  ingestSkillRun(stamp: SkillStamp, context: { timestamp: number; sessionId: string | null }): void;
}

export interface SkillRunEmitterOptions {
  readonly stdio: boolean;
  readonly getOwnSessionId: () => string;
  readonly getSink: () => SkillRunSink | undefined;
}

/**
 * Builds the `SkillActivationTracker` `onRunOpened` callback. It applies the
 * same own-session rule as `AiTurnCost`: a `--stdio` engine drains other
 * sessions' records while its own id is still provisional.
 */
export function createSkillRunEmitter(
  options: SkillRunEmitterOptions,
): (stamp: SkillStamp, ctx: SkillRunOpenContext) => void {
  return (stamp, ctx) => {
    if (
      !isTokenEventForThisProcess({
        stdio: options.stdio,
        eventSessionId: ctx.sessionId,
        ownSessionId: options.getOwnSessionId(),
      })
    ) {
      return;
    }
    options.getSink()?.ingestSkillRun(stamp, {
      timestamp: ctx.timestamp ?? Date.now(),
      sessionId: ctx.sessionId,
    });
  };
}
