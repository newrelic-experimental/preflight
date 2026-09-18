import { partitionByAgent } from './agent-partition.js';
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

// Trimmed projection of ToolSelectionMetrics with no per-call detail —
// persisted per session on FullSessionSummary (src/storage/session-store.ts)
// and used to recombine multiple sessions' scores via combineSummaries()
// below. Dropping `penalties`/`worstOffenders` avoids needing to redact
// their `detail` strings (which interpolate raw file paths) before
// persisting, mirroring how the cross-session cache-health/latency
// aggregates (src/dashboard/routes/cache-health-aggregate.ts,
// latency-percentiles.ts) also only carry summary numbers, not per-item detail.
export interface ToolSelectionSummary {
  readonly score: number;
  readonly totalCalls: number;
  readonly penalizedCalls: number;
  readonly redundantReadCount: number;
  readonly repeatedFailureCount: number;
  readonly unusedOutputCount: number;
}

export function toToolSelectionSummary(metrics: ToolSelectionMetrics): ToolSelectionSummary {
  return {
    score: metrics.score,
    totalCalls: metrics.totalCalls,
    penalizedCalls: metrics.penalizedCalls,
    redundantReadCount: metrics.redundantReadCount,
    repeatedFailureCount: metrics.repeatedFailureCount,
    unusedOutputCount: metrics.unusedOutputCount,
  };
}

export interface ToolSelectionScorerOptions {
  readonly redundantReadPenalty?: number;
  readonly repeatedFailurePenalty?: number;
  readonly unusedOutputPenalty?: number;
  readonly unusedOutputSizeThreshold?: number;
  readonly worstOffenderCount?: number;
  readonly referenceSessionSize?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REDUNDANT_READ_PENALTY = 0.03;
const DEFAULT_REPEATED_FAILURE_PENALTY = 0.08;
const DEFAULT_UNUSED_OUTPUT_PENALTY = 0.04;
const DEFAULT_UNUSED_OUTPUT_SIZE_THRESHOLD = 20000;
const DEFAULT_WORST_OFFENDER_COUNT = 10;
// Session size (in tool calls) at or below which normalization is a no-op;
// above it, penalties are diluted in proportion to size — see
// normalizePenalty(). Chosen to match the illustrative example this
// normalization is designed to fix (a 15-call session with 10 redundant
// reads applies the raw, pre-normalization penalty unchanged).
const DEFAULT_REFERENCE_SESSION_SIZE = 15;

// Tools whose output is terminal — they perform an action and their output is
// a confirmation or result, not raw data to be consumed by later tool calls.
// Penalizing these for "unused output" is nonsensical.
const TERMINAL_OUTPUT_TOOLS = new Set([
  'Edit',
  'Write',
  'Agent',
  'NotebookEdit',
  'Bash',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'SendMessage',
  'EnterPlanMode',
  'ExitPlanMode',
]);

// Discovery/search tools whose entire purpose is returning information for
// the agent to reason about, not to be consumed by a downstream Edit/Write.
// A thorough investigation is expected to produce large results here without
// ever touching a file — penalizing that as "unused output" punishes the most
// common legitimate action in a session. MCP tool results (any `mcp__`-
// prefixed name, including this project's own tools and things like
// codegraph_explore, whose entire value proposition is one large query result
// replacing many small reads) get the same treatment via a prefix check
// rather than an enumerable list, since new MCP tools appear constantly.
// Trade-off: this is unconditional, so a hypothetical MCP tool whose job is
// purely an action (analogous to Edit/Bash) is also exempt with no way to
// carve it back out short of an "MCP action tools" allowlist — accepted here
// because false negatives on that shape are rarer than the false positives
// this fix removes.
const DISCOVERY_OUTPUT_TOOLS = new Set(['Grep', 'Glob', 'WebFetch', 'WebSearch']);

function isDiscoveryOutputTool(toolName: string): boolean {
  return DISCOVERY_OUTPUT_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

// ---------------------------------------------------------------------------
// ToolSelectionScorer
// ---------------------------------------------------------------------------

export class ToolSelectionScorer {
  private readonly redundantReadPenalty: number;
  private readonly repeatedFailurePenalty: number;
  private readonly unusedOutputPenalty: number;
  private readonly unusedOutputSizeThreshold: number;
  private readonly worstOffenderCount: number;
  private readonly referenceSessionSize: number;

  constructor(options?: ToolSelectionScorerOptions) {
    this.redundantReadPenalty = options?.redundantReadPenalty ?? DEFAULT_REDUNDANT_READ_PENALTY;
    this.repeatedFailurePenalty =
      options?.repeatedFailurePenalty ?? DEFAULT_REPEATED_FAILURE_PENALTY;
    this.unusedOutputPenalty = options?.unusedOutputPenalty ?? DEFAULT_UNUSED_OUTPUT_PENALTY;
    this.unusedOutputSizeThreshold =
      options?.unusedOutputSizeThreshold ?? DEFAULT_UNUSED_OUTPUT_SIZE_THRESHOLD;
    this.worstOffenderCount = options?.worstOffenderCount ?? DEFAULT_WORST_OFFENDER_COUNT;
    this.referenceSessionSize = options?.referenceSessionSize ?? DEFAULT_REFERENCE_SESSION_SIZE;
  }

  /**
   * Normalizes a raw summed penalty by session size, one-sided: sessions AT
   * OR BELOW `referenceSessionSize` calls apply the raw penalty as-is
   * (identical to the pre-normalization absolute penalty), while sessions
   * ABOVE it get the penalty diluted in proportion to size — a 1000-call
   * session with 10 redundant reads is punished far less than a 15-call
   * session with the same 10 redundant reads. This is deliberately one-sided
   * (`Math.min(1, referenceSessionSize / totalCalls)`, never > 1): the
   * problem being fixed is large/busy sessions scoring worse than small ones
   * for an identical defect count, not small sessions scoring better — a
   * two-sided scale would fix the former by introducing the same unfairness
   * in the other direction (amplifying penalties for small sessions instead
   * of leaving them untouched). The result is still capped at 0.7 (floor of
   * 0.3) so even a session dense with violations relative to its own size
   * isn't scored as a total failure.
   */
  private normalizePenalty(rawPenalty: number, totalCalls: number): number {
    if (totalCalls <= 0) return 0;
    const scale = Math.min(1, this.referenceSessionSize / totalCalls);
    return Math.min(rawPenalty * scale, 0.7);
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

    // Redundant-read and repeated-failure detection both walk a flat,
    // timestamp-ordered sequence looking for one agent repeating itself.
    // Partition by agent (parent session + one group per subagent `agentId`)
    // first, so parallel subagents each independently doing something once
    // don't look like a single agent repeating itself.
    for (const group of partitionByAgent(toolCalls)) {
      penalties.push(...this.findRedundantReads(group));
      penalties.push(...this.findRepeatedFailures(group));
    }
    penalties.push(...this.findUnusedOutputs(toolCalls));

    const rawPenalty = penalties.reduce((sum, p) => sum + p.penaltyScore, 0);
    const totalPenalty = this.normalizePenalty(rawPenalty, toolCalls.length);
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

  /**
   * Recombines per-session summaries (each already scored independently —
   * e.g. one per session completed today) into one aggregate
   * ToolSelectionMetrics, reapplying this instance's own configured penalty
   * weights to the summed counts. Per-call detail (`penalties`/
   * `worstOffenders`) isn't reconstructable from summaries alone, so both
   * come back empty — see the ToolSelectionSummary doc comment above.
   */
  combineSummaries(summaries: readonly ToolSelectionSummary[]): ToolSelectionMetrics {
    let totalCalls = 0;
    let penalizedCalls = 0;
    let redundantReadCount = 0;
    let repeatedFailureCount = 0;
    let unusedOutputCount = 0;
    for (const s of summaries) {
      totalCalls += s.totalCalls;
      penalizedCalls += s.penalizedCalls;
      redundantReadCount += s.redundantReadCount;
      repeatedFailureCount += s.repeatedFailureCount;
      unusedOutputCount += s.unusedOutputCount;
    }

    if (totalCalls === 0) {
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

    const rawPenalty =
      redundantReadCount * this.redundantReadPenalty +
      repeatedFailureCount * this.repeatedFailurePenalty +
      unusedOutputCount * this.unusedOutputPenalty;
    const totalPenalty = this.normalizePenalty(rawPenalty, totalCalls);
    const score = Math.max(0, Math.round((1 - totalPenalty) * 1000) / 1000);

    return {
      score,
      totalCalls,
      penalizedCalls,
      penalties: [],
      worstOffenders: [],
      redundantReadCount,
      repeatedFailureCount,
      unusedOutputCount,
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
          if ((tc.toolName === 'Edit' || tc.toolName === 'Write') && tc.filePath === file) {
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
    // Track consecutive failures: reset streak when the tool succeeds or a
    // different tool is called. Only penalize back-to-back failures.
    const consecutiveFailures = new Map<string, number>();

    for (const call of toolCalls) {
      if (call.success) {
        consecutiveFailures.set(call.toolName, 0);
        continue;
      }
      const streak = (consecutiveFailures.get(call.toolName) ?? 0) + 1;
      consecutiveFailures.set(call.toolName, streak);
      if (streak > 1) {
        penalties.push({
          callId: call.id,
          toolName: call.toolName,
          reason: 'repeated_failure',
          penaltyScore: this.repeatedFailurePenalty,
          detail: `Consecutive failure of ${call.toolName} (${streak} in a row)`,
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
      if (isDiscoveryOutputTool(call.toolName)) continue;
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
          if (
            (call.toolName === 'Edit' || call.toolName === 'Write') &&
            call.filePath === filePath
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
