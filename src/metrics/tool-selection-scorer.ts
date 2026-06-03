import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSelectionPenalty {
  readonly callId: string;
  readonly toolName: string;
  readonly reason: 'redundant_read' | 'repeated_failure' | 'unused_output';
  readonly penaltyScore: number;
  readonly detail: string;
}

export interface ToolSelectionMetrics {
  readonly score: number;
  readonly totalCalls: number;
  readonly penalizedCalls: number;
  readonly penalties: readonly ToolSelectionPenalty[];
  readonly worstOffenders: readonly ToolSelectionPenalty[];
  readonly redundantReadCount: number;
  readonly repeatedFailureCount: number;
  readonly unusedOutputCount: number;
}

export interface ToolSelectionScorerOptions {
  readonly redundantReadPenalty?: number;
  readonly repeatedFailurePenalty?: number;
  readonly unusedOutputPenalty?: number;
  readonly unusedOutputSizeThreshold?: number;
  readonly worstOffenderCount?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REDUNDANT_READ_PENALTY = 0.03;
const DEFAULT_REPEATED_FAILURE_PENALTY = 0.08;
const DEFAULT_UNUSED_OUTPUT_PENALTY = 0.04;
const DEFAULT_UNUSED_OUTPUT_SIZE_THRESHOLD = 4000;
const DEFAULT_WORST_OFFENDER_COUNT = 10;

// Tools whose output is terminal — they perform an action and their output is
// a confirmation or result, not raw data to be consumed by later tool calls.
// Penalizing these for "unused output" is nonsensical.
const TERMINAL_OUTPUT_TOOLS = new Set([
  'Edit', 'Write', 'Agent', 'NotebookEdit', 'Bash',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'SendMessage', 'EnterPlanMode', 'ExitPlanMode',
]);

// ---------------------------------------------------------------------------
// ToolSelectionScorer
// ---------------------------------------------------------------------------

export class ToolSelectionScorer {
  private readonly redundantReadPenalty: number;
  private readonly repeatedFailurePenalty: number;
  private readonly unusedOutputPenalty: number;
  private readonly unusedOutputSizeThreshold: number;
  private readonly worstOffenderCount: number;

  constructor(options?: ToolSelectionScorerOptions) {
    this.redundantReadPenalty = options?.redundantReadPenalty ?? DEFAULT_REDUNDANT_READ_PENALTY;
    this.repeatedFailurePenalty = options?.repeatedFailurePenalty ?? DEFAULT_REPEATED_FAILURE_PENALTY;
    this.unusedOutputPenalty = options?.unusedOutputPenalty ?? DEFAULT_UNUSED_OUTPUT_PENALTY;
    this.unusedOutputSizeThreshold = options?.unusedOutputSizeThreshold ?? DEFAULT_UNUSED_OUTPUT_SIZE_THRESHOLD;
    this.worstOffenderCount = options?.worstOffenderCount ?? DEFAULT_WORST_OFFENDER_COUNT;
  }

  scoreSession(toolCalls: readonly ToolCallRecord[]): ToolSelectionMetrics {
    if (toolCalls.length === 0) {
      return {
        score: 1,
        totalCalls: 0,
        penalizedCalls: 0,
        penalties: [],
        worstOffenders: [],
        redundantReadCount: 0,
        repeatedFailureCount: 0,
        unusedOutputCount: 0,
      };
    }

    const penalties: ToolSelectionPenalty[] = [];

    penalties.push(...this.findRedundantReads(toolCalls));
    penalties.push(...this.findRepeatedFailures(toolCalls));
    penalties.push(...this.findUnusedOutputs(toolCalls));

    const rawPenalty = penalties.reduce((sum, p) => sum + p.penaltyScore, 0);
    // Normalize: cap penalty contribution relative to session size so that a
    // 1000-call session with 10 redundant reads isn't unfairly punished the
    // same as a 15-call session with 10 redundant reads. Effective penalty is
    // at most 70% (floor of 0.3 ensures even bad sessions aren't demoralizingly low).
    const totalPenalty = Math.min(rawPenalty, 0.7);
    const score = Math.max(0, Math.round((1 - totalPenalty) * 1000) / 1000);

    const worstOffenders = [...penalties]
      .sort((a, b) => b.penaltyScore - a.penaltyScore)
      .slice(0, this.worstOffenderCount);

    return {
      score,
      totalCalls: toolCalls.length,
      penalizedCalls: penalties.length,
      penalties,
      worstOffenders,
      redundantReadCount: penalties.filter((p) => p.reason === 'redundant_read').length,
      repeatedFailureCount: penalties.filter((p) => p.reason === 'repeated_failure').length,
      unusedOutputCount: penalties.filter((p) => p.reason === 'unused_output').length,
    };
  }

  private findRedundantReads(toolCalls: readonly ToolCallRecord[]): ToolSelectionPenalty[] {
    const penalties: ToolSelectionPenalty[] = [];
    const readFiles = new Map<string, { count: number; ids: string[]; indices: number[] }>();

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (call.toolName !== 'Read') continue;
      const file = call.filePath as string | undefined;
      if (!file) continue;

      const entry = readFiles.get(file) ?? { count: 0, ids: [], indices: [] };
      entry.count++;
      entry.ids.push(call.id);
      entry.indices.push(i);
      readFiles.set(file, entry);
    }

    for (const [file, entry] of readFiles) {
      if (entry.count <= 1) continue;
      // Only penalize reads beyond the 2nd — one re-read after editing is
      // normal verification; 3+ reads of the same file suggests lost context.
      for (let i = 2; i < entry.ids.length; i++) {
        // Skip if there was an Edit/Write to this file between reads (re-read
        // after modification is intentional, not redundant).
        const prevIdx = entry.indices[i - 1];
        const currIdx = entry.indices[i];
        let editBetween = false;
        for (let j = prevIdx + 1; j < currIdx; j++) {
          const tc = toolCalls[j];
          if ((tc.toolName === 'Edit' || tc.toolName === 'Write') &&
              tc.filePath === file) {
            editBetween = true;
            break;
          }
        }
        if (editBetween) continue;

        penalties.push({
          callId: entry.ids[i],
          toolName: 'Read',
          reason: 'redundant_read',
          penaltyScore: this.redundantReadPenalty,
          detail: `Redundant read of ${file} (read #${i + 1} of ${entry.count})`,
        });
      }
    }

    return penalties;
  }

  private findRepeatedFailures(toolCalls: readonly ToolCallRecord[]): ToolSelectionPenalty[] {
    const penalties: ToolSelectionPenalty[] = [];
    const failuresByTool = new Map<string, string[]>();

    for (const call of toolCalls) {
      if (call.success) continue;
      const key = call.toolName;
      const ids = failuresByTool.get(key) ?? [];
      ids.push(call.id);
      failuresByTool.set(key, ids);
    }

    for (const [tool, ids] of failuresByTool) {
      if (ids.length <= 1) continue;
      // Penalize consecutive failures after the first
      for (let i = 1; i < ids.length; i++) {
        penalties.push({
          callId: ids[i],
          toolName: tool,
          reason: 'repeated_failure',
          penaltyScore: this.repeatedFailurePenalty,
          detail: `Repeated failure of ${tool} (failure #${i + 1} of ${ids.length})`,
        });
      }
    }

    return penalties;
  }

  private findUnusedOutputs(toolCalls: readonly ToolCallRecord[]): ToolSelectionPenalty[] {
    const penalties: ToolSelectionPenalty[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (TERMINAL_OUTPUT_TOOLS.has(call.toolName)) continue;
      const outputSize = call.outputSizeBytes ?? 0;
      if (outputSize < this.unusedOutputSizeThreshold) continue;
      if (!call.success) continue;

      const isReferenced = this.isOutputReferenced(call, toolCalls.slice(i + 1));

      if (!isReferenced) {
        penalties.push({
          callId: call.id,
          toolName: call.toolName,
          reason: 'unused_output',
          penaltyScore: this.unusedOutputPenalty,
          detail: `Large output (${outputSize} bytes) from ${call.toolName} not referenced in subsequent turns`,
        });
      }
    }

    return penalties;
  }

  private isOutputReferenced(
    sourceCall: ToolCallRecord,
    subsequentCalls: readonly ToolCallRecord[],
  ): boolean {
    // If the source was a Read, check if the file is referenced in subsequent Edits/Writes
    if (sourceCall.toolName === 'Read') {
      const filePath = sourceCall.filePath as string | undefined;
      if (filePath) {
        for (const call of subsequentCalls) {
          if ((call.toolName === 'Edit' || call.toolName === 'Write') &&
              call.filePath === filePath) {
            return true;
          }
        }
      }
    }

    // For any tool: if subsequent calls have non-trivial input that likely
    // incorporates this output, consider it referenced. Check the next 5 calls.
    const lookAhead = subsequentCalls.slice(0, 5);
    for (const call of lookAhead) {
      const inputSize = call.inputSizeBytes ?? 0;
      if (inputSize > 500) return true;
    }

    return false;
  }
}
