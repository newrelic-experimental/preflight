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
 * `analyze(toolCalls)` is pure — it returns detected patterns for a given
 * sequence (typically one task's worth of tool calls) without depending on
 * prior calls. The detector does cache the last result (for
 * `getCurrentPatterns()`/`reset()`), so the instance itself is not stateless.
 */

import type { MetricAggregator } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AntiPatternType =
  'thrashing' | 're_reading' | 'stuck_loop' | 'blind_editing' | 'over_delegation';

export interface AntiPattern {
  readonly type: AntiPatternType;
  readonly file?: string;
  readonly command?: string;
  /** Coarse Bash category (e.g. 'test-runner', 'build', 'git') when the pattern originates from a Bash call. */
  readonly bashCategory?: string;
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

// 3 chosen consistently across all five pattern types as a low-friction
// threshold — few enough repeats that a flag still means something, but not
// so few that normal iteration (e.g. one legitimate retry) gets flagged.
// Tune per-detector via AntiPatternOptions if a specific pattern is too noisy.
const DEFAULT_THRASH_THRESHOLD = 3;
const DEFAULT_RE_READ_THRESHOLD = 3;
const DEFAULT_STUCK_LOOP_THRESHOLD = 3;
const DEFAULT_BLIND_EDIT_THRESHOLD = 3;
const DEFAULT_OVER_DELEGATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Per-category guidance for stuck-loop detection
// ---------------------------------------------------------------------------

function stuckLoopSuggestion(bashCategory: string | undefined): string {
  switch (bashCategory) {
    case 'test-runner':
      return 'Same test command keeps running — read the failure output before re-running, or change the test/code being verified';
    case 'build':
      return 'Same build command keeps running — re-running rarely fixes a build error; address the reported error';
    case 'git':
      return 'Same git command keeps running — re-running git commands rarely changes their output; check the working tree state';
    case 'network':
      return 'Same network request keeps being made — check the response body or change the request shape rather than retrying';
    default:
      return 'The same command is being run repeatedly — try a different approach';
  }
}

// ---------------------------------------------------------------------------
// AntiPatternDetector
// ---------------------------------------------------------------------------

export class AntiPatternDetector implements Resettable {
  private readonly thrashThreshold: number;
  private readonly reReadThreshold: number;
  private readonly stuckLoopThreshold: number;
  private readonly blindEditThreshold: number;
  private readonly overDelegationThreshold: number;
  private lastMetrics: AntiPatternMetrics | null = null;

  constructor(options?: AntiPatternOptions) {
    this.thrashThreshold = options?.thrashThreshold ?? DEFAULT_THRASH_THRESHOLD;
    this.reReadThreshold = options?.reReadThreshold ?? DEFAULT_RE_READ_THRESHOLD;
    this.stuckLoopThreshold = options?.stuckLoopThreshold ?? DEFAULT_STUCK_LOOP_THRESHOLD;
    this.blindEditThreshold = options?.blindEditThreshold ?? DEFAULT_BLIND_EDIT_THRESHOLD;
    this.overDelegationThreshold =
      options?.overDelegationThreshold ?? DEFAULT_OVER_DELEGATION_THRESHOLD;
  }

  analyze(toolCalls: ToolCallRecord[]): AntiPatternMetrics {
    const patterns: AntiPattern[] = [];

    patterns.push(...this.detectThrashing(toolCalls));
    patterns.push(...this.detectReReading(toolCalls));
    patterns.push(...this.detectStuckLoop(toolCalls));
    patterns.push(...this.detectBlindEditing(toolCalls));
    patterns.push(...this.detectOverDelegation(toolCalls));

    const metrics = {
      readEfficiency: this.computeReadEfficiency(toolCalls),
      verifyRate: this.computeVerifyRate(toolCalls),
      patterns,
    };

    this.lastMetrics = metrics;
    return metrics;
  }

  getCurrentPatterns(): readonly AntiPattern[] {
    return this.lastMetrics?.patterns ?? [];
  }

  reset(_sessionId: string): void {
    this.lastMetrics = null;
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
        } else {
          lastEditFile = null;
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
          // Test passed — reset cycle count for this file, but keep tracking the file
          // for subsequent test attempts (flaky tests may fail again)
          fileCycles.set(lastEditFile, 0);
        }
        // Note: Don't clear lastEditFile here. It persists until a new Edit to a different file.
        // This allows proper tracking of cycles when tests fail again after passing.
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [file, iterations] of flagged) {
      patterns.push({
        type: 'thrashing',
        file,
        iterations,
        suggestion:
          'Consider reading the test output more carefully or reading the test framework docs',
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
      // Match Read and common platform-specific read variants (NotebookRead, mcp__ide__read, etc.)
      if (
        call.toolName === 'Read' ||
        call.toolName === 'NotebookRead' ||
        call.toolName.toLowerCase().includes('read')
      ) {
        const file = call.filePath as string | undefined;
        if (file) {
          readCounts.set(file, (readCounts.get(file) ?? 0) + 1);
        }
      }
    }

    const patterns: AntiPattern[] = [];
    for (const [file, count] of readCounts) {
      if (count >= this.reReadThreshold) {
        patterns.push({
          type: 're_reading',
          file,
          readCount: count,
          suggestion:
            'Context may have been compressed — consider breaking the task into smaller pieces',
        });
      }
    }

    return patterns;
  }

  // ---------------------------------------------------------------------------
  // Stuck loop: same Bash command repeated consecutively
  // ---------------------------------------------------------------------------

  private detectStuckLoop(toolCalls: ToolCallRecord[]): AntiPattern[] {
    const flagged = new Map<string, { repeatCount: number; bashCategory?: string }>();

    let lastCommand: string | null = null;
    let lastCategory: string | undefined;
    let consecutiveCount = 0;

    for (const call of toolCalls) {
      if (call.toolName === 'Bash') {
        const command = call.command as string | undefined;
        const category = typeof call.bashCategory === 'string' ? call.bashCategory : undefined;
        if (command != null) {
          if (command === lastCommand) {
            consecutiveCount++;
            if (consecutiveCount >= this.stuckLoopThreshold) {
              flagged.set(command, { repeatCount: consecutiveCount, bashCategory: lastCategory });
            }
          } else {
            lastCommand = command;
            lastCategory = category;
            consecutiveCount = 1;
          }
        }
      }
      // Non-Bash calls are transparent to stuck-loop detection: Bash(cmd) → Read → Bash(cmd)
      // still counts as two repetitions of the same command.
    }

    const patterns: AntiPattern[] = [];
    for (const [command, { repeatCount, bashCategory }] of flagged) {
      patterns.push({
        type: 'stuck_loop',
        command,
        repeatCount,
        bashCategory,
        suggestion: stuckLoopSuggestion(bashCategory),
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
          if (count >= this.blindEditThreshold) {
            flagged.set(file, count);
          }
        }
      } else if (call.toolName === 'Read') {
        const file = call.filePath as string | undefined;
        if (file) {
          editStreaks.delete(file);
        }
      } else if (
        call.toolName === 'Bash' &&
        (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
      ) {
        if (call.success) {
          // A successful verification clears streaks for every file, not just
          // the one being edited — a passing test/build/lint run typically
          // verifies the whole batch of pending changes at once, not one
          // file in isolation.
          editStreaks.clear();
        }
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

    if (agentCount >= this.overDelegationThreshold) {
      return [
        {
          type: 'over_delegation',
          agentCount,
          suggestion: 'Too many sub-agents spawned — consider handling more work directly',
        },
      ];
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
