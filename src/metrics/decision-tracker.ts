import type { ToolCallRecord } from '../storage/types.js';
import { extractReasoningForToolUse } from './transcript-reasoning.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BranchOutcome = 'success' | 'failure' | 'unknown';

export interface DecisionBranch {
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly reasoning: string;
  readonly chosenAction: string;
  readonly toolName: string | null;
  readonly outcome: BranchOutcome;
  readonly nextToolSuccess: boolean | null;
  readonly sessionSucceeded: boolean | null;
}

export interface DecisionTreeMetrics {
  readonly totalBranches: number;
  readonly successRate: number | null;
  readonly failurePoints: readonly DecisionBranch[];
  readonly longestFailureStreak: number;
  readonly firstFailureIndex: number | null;
  readonly note: string;
}

export interface DecisionTrackerOptions {
  readonly maxBranches?: number;
  readonly reasoningMaxLength?: number;
  readonly recordContent?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BRANCHES = 500;
const DEFAULT_REASONING_MAX_LENGTH = 500;

export const DECISION_TREE_REASONING_NOTE =
  "reasoning fields are the model's own thinking/text output for that turn when NEW_RELIC_AI_MCP_RECORD_CONTENT is enabled and the underlying model exposes plaintext reasoning -- some models/transports return only an encrypted thinking signature with no plaintext, in which case this falls back to a rule-based label (e.g. 'recovery after X failure'). Branches are only recorded on 3 narrow triggers (failure recovery, AskUserQuestion, 3rd+ same-tool-same-file retry), not on every turn, so totalBranches undercounts ordinary turns.";

// ---------------------------------------------------------------------------
// DecisionTracker
// ---------------------------------------------------------------------------

export class DecisionTracker {
  private readonly maxBranches: number;
  private readonly reasoningMaxLength: number;
  private readonly recordContent: boolean;
  private readonly branches: DecisionBranch[] = [];

  private turnCounter = 0;
  private lastRecordFailed = false;
  private lastToolName: string | null = null;
  private fileCallCounts = new Map<string, number>();

  constructor(options?: DecisionTrackerOptions) {
    this.maxBranches = options?.maxBranches ?? DEFAULT_MAX_BRANCHES;
    this.reasoningMaxLength = options?.reasoningMaxLength ?? DEFAULT_REASONING_MAX_LENGTH;
    this.recordContent = options?.recordContent ?? false;
  }

  recordToolCall(record: ToolCallRecord): void {
    this.turnCounter++;
    const turn = this.turnCounter;
    const transcriptPath = record.transcriptPath as string | undefined;

    if (this.lastRecordFailed) {
      // Previous tool failed — this tool call represents a recovery decision
      this.recordDecision({
        turnNumber: turn,
        reasoning:
          this.extractReasoning(transcriptPath, record.toolUseId) ??
          `recovery after ${this.lastToolName ?? 'unknown'} failure`,
        chosenAction: record.toolName,
        toolName: record.toolName,
      });
    }

    if (record.toolName === 'AskUserQuestion') {
      this.recordDecision({
        turnNumber: turn,
        reasoning: this.extractReasoning(transcriptPath, record.toolUseId) ?? 'delegating to user',
        chosenAction: 'ask_user',
        toolName: record.toolName,
      });
    }

    // Detect retry decisions: same tool on same file 3+ times
    const filePath = record.filePath as string | undefined;
    if (filePath) {
      const key = `${record.toolName}:${filePath}`;
      const count = (this.fileCallCounts.get(key) ?? 0) + 1;
      this.fileCallCounts.set(key, count);
      if (count >= 3) {
        this.recordDecision({
          turnNumber: turn,
          reasoning:
            this.extractReasoning(transcriptPath, record.toolUseId) ??
            `retrying ${record.toolName} on ${filePath} (${count} attempts)`,
          chosenAction: 'retry',
          toolName: record.toolName,
        });
      }
    }

    // Record outcome for the most recent pending branch
    if (this.branches.length > 0) {
      this.recordOutcome(turn, record.success);
    }

    this.lastRecordFailed = !record.success;
    this.lastToolName = record.toolName;
  }

  private extractReasoning(transcriptPath: string | undefined, toolUseId: string): string | null {
    if (!this.recordContent || !transcriptPath) return null;
    return extractReasoningForToolUse(transcriptPath, toolUseId);
  }

  recordDecision(input: {
    turnNumber: number;
    reasoning: string;
    chosenAction: string;
    toolName: string | null;
  }): void {
    const branch: DecisionBranch = {
      turnNumber: input.turnNumber,
      timestamp: Date.now(),
      reasoning: input.reasoning.slice(0, this.reasoningMaxLength),
      chosenAction: input.chosenAction.slice(0, this.reasoningMaxLength),
      toolName: input.toolName,
      outcome: 'unknown',
      nextToolSuccess: null,
      sessionSucceeded: null,
    };

    this.branches.push(branch);
    if (this.branches.length > this.maxBranches) {
      this.branches.shift();
    }
  }

  recordOutcome(turnNumber: number, success: boolean): void {
    // Tag the most recent branch at or before this turn
    for (let i = this.branches.length - 1; i >= 0; i--) {
      const branch = this.branches[i];
      if (branch.turnNumber <= turnNumber && branch.nextToolSuccess === null) {
        (
          this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }
        ).nextToolSuccess = success;
        (this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }).outcome =
          success ? 'success' : 'failure';
        break;
      }
    }
  }

  markSessionOutcome(succeeded: boolean): void {
    for (let i = 0; i < this.branches.length; i++) {
      (
        this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }
      ).sessionSucceeded = succeeded;
    }
  }

  getMetrics(): DecisionTreeMetrics {
    const resolved = this.branches.filter((b) => b.outcome !== 'unknown');
    const successes = resolved.filter((b) => b.outcome === 'success').length;
    const successRate = resolved.length > 0 ? successes / resolved.length : null;
    const failurePoints = this.branches.filter((b) => b.outcome === 'failure');

    return {
      totalBranches: this.branches.length,
      successRate: successRate !== null ? Math.round(successRate * 1000) / 1000 : null,
      failurePoints,
      longestFailureStreak: this.computeLongestFailureStreak(),
      firstFailureIndex: this.findFirstFailureIndex(),
      note: DECISION_TREE_REASONING_NOTE,
    };
  }

  getBranches(): readonly DecisionBranch[] {
    return this.branches;
  }

  getPostMortem(): readonly DecisionBranch[] {
    // Return branches leading up to and including failures for debugging
    const result: DecisionBranch[] = [];
    let inFailureZone = false;

    for (const branch of this.branches) {
      if (branch.outcome === 'failure') {
        inFailureZone = true;
        result.push(branch);
      } else if (inFailureZone) {
        // Include the recovery branch after a failure
        result.push(branch);
        if (branch.outcome === 'success') {
          inFailureZone = false;
        }
      }
    }

    return result;
  }

  reset(_sessionId: string): void {
    this.branches.length = 0;
    this.turnCounter = 0;
    this.lastRecordFailed = false;
    this.lastToolName = null;
    this.fileCallCounts.clear();
  }

  private computeLongestFailureStreak(): number {
    let maxStreak = 0;
    let currentStreak = 0;

    for (const branch of this.branches) {
      if (branch.outcome === 'failure') {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else if (branch.outcome === 'success') {
        currentStreak = 0;
      }
    }

    return maxStreak;
  }

  private findFirstFailureIndex(): number | null {
    for (let i = 0; i < this.branches.length; i++) {
      if (this.branches[i].outcome === 'failure') {
        return i;
      }
    }
    return null;
  }
}
