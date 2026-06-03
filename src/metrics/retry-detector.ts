import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';

const logger = createLogger('retry-detector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThrashingAlert {
  readonly toolName: string;
  readonly occurrences: number;
  readonly windowSize: number;
  readonly similarity: number;
  readonly tokensWastedEstimate: number;
  readonly timestamp: number;
}

export interface RetryDetectorMetrics {
  readonly alerts: readonly ThrashingAlert[];
  readonly totalTokensWasted: number;
  readonly totalAlertsEmitted: number;
}

export interface RetryDetectorOptions {
  readonly minOccurrences?: number;
  readonly windowSize?: number;
  readonly similarityThreshold?: number;
  readonly onAlert?: (alert: ThrashingAlert) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const BYTES_PER_TOKEN_ESTIMATE = 4;

// ---------------------------------------------------------------------------
// Levenshtein similarity
// ---------------------------------------------------------------------------

export function normalizedLevenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // Truncate long strings to avoid O(n^2) on massive inputs
  const limit = 2000;
  const sa = a.length > limit ? a.slice(0, limit) : a;
  const sb = b.length > limit ? b.slice(0, limit) : b;
  const effectiveMax = Math.max(sa.length, sb.length);

  const distance = levenshteinDistance(sa, sb);
  return 1 - distance / effectiveMax;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Single-row DP for space efficiency
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j];
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev;
      } else {
        row[j] = 1 + Math.min(prev, row[j], row[j - 1]);
      }
      prev = temp;
    }
  }

  return row[n];
}

// ---------------------------------------------------------------------------
// RetryDetector
// ---------------------------------------------------------------------------

export class RetryDetector {
  private readonly minOccurrences: number;
  private readonly windowSize: number;
  private readonly similarityThreshold: number;
  private readonly onAlert: ((alert: ThrashingAlert) => void) | null;

  private readonly recentCalls: ToolCallRecord[] = [];
  private readonly alerts: ThrashingAlert[] = [];
  private totalTokensWasted = 0;
  // Track which tool+window combos already fired to avoid spamming
  private readonly firedKeys = new Set<string>();
  private callCounter = 0;

  constructor(options?: RetryDetectorOptions) {
    this.minOccurrences = options?.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.onAlert = options?.onAlert ?? null;
  }

  recordToolCall(record: ToolCallRecord): ThrashingAlert | null {
    this.recentCalls.push(record);
    this.callCounter++;

    // Only keep the window we need
    if (this.recentCalls.length > this.windowSize * 2) {
      this.recentCalls.splice(0, this.recentCalls.length - this.windowSize * 2);
    }

    return this.checkWindow();
  }

  getMetrics(): RetryDetectorMetrics {
    return {
      alerts: this.alerts,
      totalTokensWasted: this.totalTokensWasted,
      totalAlertsEmitted: this.alerts.length,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    if (this.alerts.length > 0) {
      aggregator.record('ai.retry.alerts_total', this.alerts.length);
      aggregator.record('ai.retry.tokens_wasted', this.totalTokensWasted);
    }
  }

  reset(_sessionId: string): void {
    this.recentCalls.length = 0;
    this.alerts.length = 0;
    this.totalTokensWasted = 0;
    this.firedKeys.clear();
    this.callCounter = 0;
  }

  private checkWindow(): ThrashingAlert | null {
    const window = this.recentCalls.slice(-this.windowSize);
    if (window.length < this.minOccurrences) return null;

    // Group calls by tool name within the window
    const byTool = new Map<string, ToolCallRecord[]>();
    for (const call of window) {
      const arr = byTool.get(call.toolName) ?? [];
      arr.push(call);
      byTool.set(call.toolName, arr);
    }

    for (const [toolName, calls] of byTool) {
      if (calls.length < this.minOccurrences) continue;

      // Check: either all failed, or inputs are highly similar
      const allFailed = calls.every((c) => !c.success);
      const similarity = this.computeGroupSimilarity(calls);
      const isSimilar = similarity >= this.similarityThreshold;

      if (!allFailed && !isSimilar) continue;

      // Dedupe: use the call counter so alerts can fire again after new calls arrive
      const dedupeKey = `${toolName}:${this.callCounter}`;
      if (this.firedKeys.has(dedupeKey)) continue;
      this.firedKeys.add(dedupeKey);

      const tokensWasted = this.estimateTokensWasted(calls);
      const alert: ThrashingAlert = {
        toolName,
        occurrences: calls.length,
        windowSize: this.windowSize,
        similarity,
        tokensWastedEstimate: tokensWasted,
        timestamp: Date.now(),
      };

      this.alerts.push(alert);
      this.totalTokensWasted += tokensWasted;

      logger.warn('Thrashing detected', {
        tool: toolName,
        occurrences: calls.length,
        similarity: Math.round(similarity * 100),
        tokensWasted,
      });

      if (this.onAlert) {
        this.onAlert(alert);
      }

      return alert;
    }

    return null;
  }

  private computeGroupSimilarity(calls: ToolCallRecord[]): number {
    if (calls.length < 2) return 0;

    const inputs = calls.map((c) => this.serializeInput(c));
    let totalSimilarity = 0;
    let comparisons = 0;

    // Compare each pair against the first (reference) input
    const reference = inputs[0];
    for (let i = 1; i < inputs.length; i++) {
      totalSimilarity += normalizedLevenshteinSimilarity(reference, inputs[i]);
      comparisons++;
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  private serializeInput(record: ToolCallRecord): string {
    const { id: _id, sessionId: _s, timestamp: _t, durationMs: _d, success: _su,
      errorType: _e, error: _er, inputSizeBytes: _is, outputSizeBytes: _os,
      inputHash: _ih, toolUseId: _tu, ...rest } = record;
    try {
      return JSON.stringify(rest, null, 0);
    } catch {
      return '';
    }
  }

  private estimateTokensWasted(calls: ToolCallRecord[]): number {
    let totalBytes = 0;
    for (const call of calls) {
      totalBytes += (call.inputSizeBytes ?? 0) + (call.outputSizeBytes ?? 0);
    }
    return Math.ceil(totalBytes / BYTES_PER_TOKEN_ESTIMATE);
  }
}
