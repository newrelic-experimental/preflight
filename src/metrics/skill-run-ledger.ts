import type { SkillStamp, ToolCallRecord } from '../storage/types.js';
import type { SkillRunOpenContext } from './skill-activation-tracker.js';
import type { ClosedTurn } from './turn-cost-attributor.js';

/** One skill run, closed, with the totals of the work done inside it. */
export interface ClosedSkillRun {
  readonly stamp: SkillStamp;
  readonly sessionId: string | null;
  /** The subagent that opened the run. Absent when the main agent did. */
  readonly agentId?: string;
  readonly platform?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly toolCallCount: number;
  /** The calls in `toolCallCount` whose turn got a token report. */
  readonly pricedCallCount: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

type Totals = {
  -readonly [
    K in
      | 'endedAt'
      | 'toolCallCount'
      | 'pricedCallCount'
      | 'costUsd'
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheCreationTokens'
  ]: ClosedSkillRun[K];
};

interface Run {
  readonly base: Omit<ClosedSkillRun, keyof Totals>;
  readonly totals: Totals;
  closedAt: number | null;
  /** Stamped calls still waiting in a turn for their token report. */
  unpriced: number;
}

// Same window TurnCostAttributor waits before it evicts a burst whose token
// report never came, after which these calls can no longer be priced.
const STALE_UNPRICED_MS = 10 * 60 * 1000;
const MAX_RUNS = 256;

/**
 * Totals each skill run and hands it to `onClosed` once. A run closes at the
 * next prompt in its session, or when the agent that opened it opens another
 * skill. It is handed over when every call it made has been priced, or after
 * `STALE_UNPRICED_MS`, or on `flush()`. Cost and tokens are the run's even
 * shares of each turn, the same values its `AiTurnCost` rows carry.
 */
export class SkillRunLedger {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly onClosed: (run: ClosedSkillRun) => void) {}

  recordRunOpened(stamp: SkillStamp, ctx: SkillRunOpenContext): void {
    const at = ctx.timestamp ?? Date.now();
    for (const run of this.openRuns(ctx.sessionId)) {
      if (run.base.agentId !== ctx.agentId) continue;
      run.totals.endedAt = Math.max(run.totals.endedAt, at);
      this.close(run, at);
    }
    this.runs.set(stamp.runId, {
      base: {
        stamp,
        sessionId: ctx.sessionId,
        ...(ctx.agentId !== undefined && { agentId: ctx.agentId }),
        ...(ctx.platform !== undefined && { platform: ctx.platform }),
        startedAt: at,
      },
      totals: {
        endedAt: at,
        toolCallCount: 0,
        pricedCallCount: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      closedAt: null,
      unpriced: 0,
    });
    if (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.values().next().value;
      if (oldest) this.emit(oldest);
    }
  }

  /** Call before the prompt can open a slash run, so it closes only the runs before it. */
  recordPrompt(sessionId: string | null | undefined, timestamp: number): void {
    for (const run of this.openRuns(sessionId ?? null)) this.close(run, timestamp);
  }

  /** The main agent finished its turn, so its open run was busy until now. */
  recordStop(sessionId: string | null | undefined, timestamp: number): void {
    for (const run of this.openRuns(sessionId ?? null)) {
      if (run.base.agentId === undefined) {
        run.totals.endedAt = Math.max(run.totals.endedAt, timestamp);
      }
    }
  }

  recordToolCall(record: ToolCallRecord): void {
    const run = record.activeSkill && this.runs.get(record.activeSkill.runId);
    if (!run) return;
    run.totals.toolCallCount++;
    run.unpriced++;
    run.totals.endedAt = Math.max(run.totals.endedAt, record.timestamp + (record.durationMs ?? 0));
  }

  recordClosedTurn(turn: ClosedTurn): void {
    const { attribution, calls } = turn;
    for (const call of calls) {
      const run = call.skill && this.runs.get(call.skill.runId);
      if (!run) continue;
      run.unpriced--;
      run.totals.pricedCallCount++;
      run.totals.costUsd += attribution.costPerToolCall;
      run.totals.inputTokens += attribution.inputTokens / calls.length;
      run.totals.outputTokens += attribution.outputTokens / calls.length;
      run.totals.cacheReadTokens += attribution.cacheReadTokens / calls.length;
      run.totals.cacheCreationTokens += attribution.cacheCreationTokens / calls.length;
      this.settle(run);
    }
    for (const run of [...this.runs.values()]) {
      if (run.closedAt !== null && attribution.endTime - run.closedAt > STALE_UNPRICED_MS) {
        this.emit(run);
      }
    }
  }

  /** Hands over every run, open or not, with what it has so far. */
  flush(): void {
    for (const run of [...this.runs.values()]) this.emit(run);
  }

  private openRuns(sessionId: string | null): Run[] {
    return [...this.runs.values()].filter(
      (run) => run.closedAt === null && run.base.sessionId === sessionId,
    );
  }

  private close(run: Run, at: number): void {
    run.closedAt = at;
    this.settle(run);
  }

  private settle(run: Run): void {
    if (run.closedAt !== null && run.unpriced <= 0) this.emit(run);
  }

  private emit(run: Run): void {
    this.runs.delete(run.base.stamp.runId);
    this.onClosed({ ...run.base, ...run.totals });
  }
}
