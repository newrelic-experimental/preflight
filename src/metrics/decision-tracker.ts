
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
}

export interface DecisionTrackerOptions {
  readonly maxBranches?: number;
  readonly reasoningMaxLength?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BRANCHES = 500;
const DEFAULT_REASONING_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// DecisionTracker
// ---------------------------------------------------------------------------

export class DecisionTracker {
  private readonly maxBranches: number;
  private readonly reasoningMaxLength: number;
  private readonly branches: DecisionBranch[] = [];

  constructor(options?: DecisionTrackerOptions) {
    this.maxBranches = options?.maxBranches ?? DEFAULT_MAX_BRANCHES;
    this.reasoningMaxLength = options?.reasoningMaxLength ?? DEFAULT_REASONING_MAX_LENGTH;
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
        (this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }).nextToolSuccess = success;
        (this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }).outcome = success ? 'success' : 'failure';
        break;
      }
    }
  }

  markSessionOutcome(succeeded: boolean): void {
    for (let i = 0; i < this.branches.length; i++) {
      (this.branches[i] as { -readonly [K in keyof DecisionBranch]: DecisionBranch[K] }).sessionSucceeded = succeeded;
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
