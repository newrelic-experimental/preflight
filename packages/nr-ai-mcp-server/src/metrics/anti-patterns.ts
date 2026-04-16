/**
 * Anti-Pattern Detection — analyzes tool call sequences to identify
 * inefficient AI coding patterns.
 *
 * Detects:
 *   1. Thrashing: Edit → test FAIL cycles on the same file
 *   2. Re-reading: reading the same file excessively
 *   3. Stuck loop: running the same Bash command repeatedly
 *   4. Blind editing: multiple edits without verification
 *   5. Over-delegation: spawning too many sub-agents
 *
 * The detector is stateless: `analyze(toolCalls)` returns detected patterns
 * for a given sequence (typically one task's worth of tool calls).
 */

import type { MetricAggregator } from '@nr-ai-observatory/shared';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AntiPatternType =
  | 'thrashing'
  | 're_reading'
  | 'stuck_loop'
  | 'blind_editing'
  | 'over_delegation';

export interface AntiPattern {
  readonly type: AntiPatternType;
  readonly file?: string;
  readonly command?: string;
  readonly iterations?: number;
  readonly readCount?: number;
  readonly repeatCount?: number;
  readonly editCount?: number;
  readonly agentCount?: number;
  readonly suggestion: string;
}

export interface AntiPatternMetrics {
  readonly readEfficiency: number | null;
  readonly verifyRate: number | null;
  readonly patterns: AntiPattern[];
}

export interface AntiPatternOptions {
  readonly thrashThreshold?: number;
  readonly reReadThreshold?: number;
  readonly stuckLoopThreshold?: number;
  readonly blindEditThreshold?: number;
  readonly overDelegationThreshold?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRASH_THRESHOLD = 3;
const DEFAULT_RE_READ_THRESHOLD = 3;
const DEFAULT_STUCK_LOOP_THRESHOLD = 3;
const DEFAULT_BLIND_EDIT_THRESHOLD = 3;
const DEFAULT_OVER_DELEGATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// AntiPatternDetector
// ---------------------------------------------------------------------------

export class AntiPatternDetector {
  private readonly thrashThreshold: number;
  private readonly reReadThreshold: number;
  private readonly stuckLoopThreshold: number;
  private readonly blindEditThreshold: number;
  private readonly overDelegationThreshold: number;

  constructor(options?: AntiPatternOptions) {
    this.thrashThreshold = options?.thrashThreshold ?? DEFAULT_THRASH_THRESHOLD;
    this.reReadThreshold = options?.reReadThreshold ?? DEFAULT_RE_READ_THRESHOLD;
    this.stuckLoopThreshold = options?.stuckLoopThreshold ?? DEFAULT_STUCK_LOOP_THRESHOLD;
    this.blindEditThreshold = options?.blindEditThreshold ?? DEFAULT_BLIND_EDIT_THRESHOLD;
    this.overDelegationThreshold = options?.overDelegationThreshold ?? DEFAULT_OVER_DELEGATION_THRESHOLD;
  }

  analyze(toolCalls: ToolCallRecord[]): AntiPatternMetrics {
    const patterns: AntiPattern[] = [];

    patterns.push(...this.detectThrashing(toolCalls));
    patterns.push(...this.detectReReading(toolCalls));
    patterns.push(...this.detectStuckLoop(toolCalls));
    patterns.push(...this.detectBlindEditing(toolCalls));
    patterns.push(...this.detectOverDelegation(toolCalls));

    return {
      readEfficiency: this.computeReadEfficiency(toolCalls),
      verifyRate: this.computeVerifyRate(toolCalls),
      patterns,
    };
  }

  emitMetrics(aggregator: MetricAggregator, patterns: AntiPattern[]): void {
    for (const pattern of patterns) {
      aggregator.record('ai.anti_pattern.count', 1, { type: pattern.type });
    }
  }

  // ---------------------------------------------------------------------------
  // Thrashing: Edit(file) → Bash(test:FAIL) repeated on the same file
  // ---------------------------------------------------------------------------

  private detectThrashing(toolCalls: ToolCallRecord[]): AntiPattern[] {
    // Track per-file: consecutive Edit→test-FAIL cycles
    const fileCycles = new Map<string, number>();
    const flagged = new Map<string, number>();

    let lastEditFile: string | null = null;

    for (const call of toolCalls) {
      if (call.toolName === 'Edit' || call.toolName === 'Write') {
        const file = call.filePath as string | undefined;
        if (file) {
          lastEditFile = file;
        }
      } else if (call.toolName === 'Bash' && call.isTestCommand && lastEditFile !== null) {
        if (!call.success) {
          // Edit → test FAIL cycle
          const count = (fileCycles.get(lastEditFile) ?? 0) + 1;
          fileCycles.set(lastEditFile, count);
          if (count >= this.thrashThreshold) {
            flagged.set(lastEditFile, count);
          }
        } else {
          // Test passed — reset cycle count for this file
          fileCycles.set(lastEditFile, 0);
        }
        lastEditFile = null;
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [file, iterations] of flagged) {
      patterns.push({
        type: 'thrashing',
        file,
        iterations,
        suggestion: 'Consider reading the test output more carefully or reading the test framework docs',
      });
    }

    return patterns;
  }

  // ---------------------------------------------------------------------------
  // Re-reading: same file read more than threshold times
  // ---------------------------------------------------------------------------

  private detectReReading(toolCalls: ToolCallRecord[]): AntiPattern[] {
    const readCounts = new Map<string, number>();

    for (const call of toolCalls) {
      if (call.toolName === 'Read') {
        const file = call.filePath as string | undefined;
        if (file) {
          readCounts.set(file, (readCounts.get(file) ?? 0) + 1);
        }
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [file, count] of readCounts) {
      if (count > this.reReadThreshold) {
        patterns.push({
          type: 're_reading',
          file,
          readCount: count,
          suggestion: 'Context may have been compressed — consider breaking the task into smaller pieces',
        });
      }
    }

    return patterns;
  }

  // ---------------------------------------------------------------------------
  // Stuck loop: same Bash command repeated consecutively
  // ---------------------------------------------------------------------------

  private detectStuckLoop(toolCalls: ToolCallRecord[]): AntiPattern[] {
    const flagged = new Map<string, number>();

    let lastCommand: string | null = null;
    let consecutiveCount = 0;

    for (const call of toolCalls) {
      if (call.toolName === 'Bash') {
        const command = call.command as string | undefined;
        if (command != null) {
          if (command === lastCommand) {
            consecutiveCount++;
            if (consecutiveCount >= this.stuckLoopThreshold) {
              flagged.set(command, consecutiveCount);
            }
          } else {
            lastCommand = command;
            consecutiveCount = 1;
          }
        }
      } else {
        // Non-Bash call breaks the consecutive Bash sequence
        lastCommand = null;
        consecutiveCount = 0;
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [command, repeatCount] of flagged) {
      patterns.push({
        type: 'stuck_loop',
        command,
        repeatCount,
        suggestion: 'The same command is being run repeatedly — try a different approach',
      });
    }

    return patterns;
  }

  // ---------------------------------------------------------------------------
  // Blind editing: multiple Edit/Write to same file without verification
  // ---------------------------------------------------------------------------

  private detectBlindEditing(toolCalls: ToolCallRecord[]): AntiPattern[] {
    // Track consecutive edits per file without an intervening verification command
    const editStreaks = new Map<string, number>();
    const flagged = new Map<string, number>();

    for (const call of toolCalls) {
      if (call.toolName === 'Edit' || call.toolName === 'Write') {
        const file = call.filePath as string | undefined;
        if (file) {
          const count = (editStreaks.get(file) ?? 0) + 1;
          editStreaks.set(file, count);
          if (count > this.blindEditThreshold) {
            flagged.set(file, count);
          }
        }
      } else if (
        call.toolName === 'Bash' &&
        (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
      ) {
        // Verification command resets all edit streaks
        editStreaks.clear();
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [file, editCount] of flagged) {
      patterns.push({
        type: 'blind_editing',
        file,
        editCount,
        suggestion: 'Verify changes with tests between edits',
      });
    }

    return patterns;
  }

  // ---------------------------------------------------------------------------
  // Over-delegation: too many Agent tool calls
  // ---------------------------------------------------------------------------

  private detectOverDelegation(toolCalls: ToolCallRecord[]): AntiPattern[] {
    let agentCount = 0;

    for (const call of toolCalls) {
      if (call.toolName === 'Agent') {
        agentCount++;
      }
    }

    if (agentCount > this.overDelegationThreshold) {
      return [{
        type: 'over_delegation',
        agentCount,
        suggestion: 'Too many sub-agents spawned — consider handling more work directly',
      }];
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Efficiency metrics
  // ---------------------------------------------------------------------------

  private computeReadEfficiency(toolCalls: ToolCallRecord[]): number | null {
    const uniqueFiles = new Set<string>();
    let totalReads = 0;

    for (const call of toolCalls) {
      if (call.toolName === 'Read') {
        totalReads++;
        const file = call.filePath as string | undefined;
        if (file) uniqueFiles.add(file);
      }
    }

    if (totalReads === 0) return null;
    return Math.round((uniqueFiles.size / totalReads) * 100) / 100;
  }

  private computeVerifyRate(toolCalls: ToolCallRecord[]): number | null {
    let totalEdits = 0;
    let editsFollowedByVerification = 0;
    let pendingEditCount = 0;

    for (const call of toolCalls) {
      if (call.toolName === 'Edit' || call.toolName === 'Write') {
        totalEdits++;
        pendingEditCount++;
      } else if (
        call.toolName === 'Bash' &&
        (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
      ) {
        if (pendingEditCount > 0) {
          editsFollowedByVerification += pendingEditCount;
          pendingEditCount = 0;
        }
      }
    }

    if (totalEdits === 0) return null;
    return Math.round((editsFollowedByVerification / totalEdits) * 1000) / 1000;
  }
}
