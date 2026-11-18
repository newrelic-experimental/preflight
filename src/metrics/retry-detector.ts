/**
 * Retry/Thrashing Detection — within a tool+session group in a sliding window
 * of recent calls, takes the first failed call and the calls after it, and
 * flags them as a retry when they all failed or their inputs are near-identical
 * (Levenshtein similarity over each call's serialized non-metadata fields, see
 * computeGroupSimilarity()). Calls before the first failure are never retries,
 * and a success after it counts only as the retry that finally worked. An
 * alert fires only when the call just recorded joins the offending group, and
 * each call is charged to at most one alert.
 */

import type { MetricAggregator } from '../core/index.js';
import { createLogger } from '../core/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { Resettable } from './tracker-contracts.js';

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
  /**
   * The Claude Code session that produced the flagged calls. `null` when the
   * underlying ToolCallRecords carry no session id (legacy/proxy-originated
   * records) — callers should treat that as "unattributed", not "session A".
   */
  readonly sessionId: string | null;
}

export interface RetrySessionBreakdown {
  readonly tokensWasted: number;
  readonly alertCount: number;
}

export interface RetryDetectorMetrics {
  readonly alerts: readonly ThrashingAlert[];
  readonly totalTokensWasted: number;
  readonly totalAlertsEmitted: number;
  readonly bySession: Readonly<Record<string, RetrySessionBreakdown>>;
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
// Same rough chars-per-token heuristic used elsewhere in this codebase for
// estimating token counts without an actual tokenizer (see CostTracker's
// recordEstimatedTokens). Only used here to estimate wasted tokens for
// reporting, not for billing, so the approximation is acceptable.
const BYTES_PER_TOKEN_ESTIMATE = 4;
// Bounds memory for a long-running --local process — mirrors
// TurnCostAttributor's MAX_TURNS bound for the same failure mode.
const MAX_ALERTS = 200;
// Mirrors ContextTrackerRegistry/TurnCostAttributor's session-churn bound so
// this map doesn't grow unboundedly as distinct session ids accumulate over
// a long-running process's lifetime.
const DEFAULT_MAX_SESSIONS = 50;
// Single owner of this sentinel — api-handler.ts's retryAlertsBySession()
// used to own this convention locally; it now reads the pre-aggregated
// bySession map this class maintains, so this is the one place that decides
// how a sessionless alert rolls up.
const UNKNOWN_SESSION_KEY = 'unknown';

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

export class RetryDetector implements Resettable {
  private readonly minOccurrences: number;
  private readonly windowSize: number;
  private readonly similarityThreshold: number;
  private readonly onAlert: ((alert: ThrashingAlert) => void) | null;

  private readonly recentCalls: ToolCallRecord[] = [];
  private readonly alerts: ThrashingAlert[] = [];
  private totalTokensWasted = 0;
  private totalAlertsEmitted = 0;
  private readonly bySession = new Map<string, RetrySessionBreakdown>();
  // Ids of calls in recentCalls already charged to an alert.
  private readonly chargedIds = new Set<string>();

  constructor(options?: RetryDetectorOptions) {
    this.minOccurrences = options?.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.onAlert = options?.onAlert ?? null;
  }

  recordToolCall(record: ToolCallRecord): ThrashingAlert | null {
    this.recentCalls.push(record);

    if (this.recentCalls.length > this.windowSize) {
      const evicted = this.recentCalls.splice(0, this.recentCalls.length - this.windowSize);
      for (const call of evicted) this.chargedIds.delete(call.id);
    }

    return this.checkWindow(record);
  }

  getMetrics(): RetryDetectorMetrics {
    return {
      alerts: this.alerts,
      totalTokensWasted: this.totalTokensWasted,
      totalAlertsEmitted: this.totalAlertsEmitted,
      bySession: Object.fromEntries(this.bySession),
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    if (this.totalAlertsEmitted > 0) {
      aggregator.record('ai.retry.alerts_total', this.totalAlertsEmitted);
      aggregator.record('ai.retry.tokens_wasted', this.totalTokensWasted);
    }
  }

  reset(_sessionId: string): void {
    this.recentCalls.length = 0;
    this.alerts.length = 0;
    this.totalTokensWasted = 0;
    this.totalAlertsEmitted = 0;
    this.bySession.clear();
    this.chargedIds.clear();
  }

  private checkWindow(latest: ToolCallRecord): ThrashingAlert | null {
    // Grouped by session as well as tool: a shared detector in --local mode
    // sees every live session's calls, and identical ordinary commands in two
    // sessions are not one retry loop.
    const sessionKey = latest.sessionId ?? '';
    const group = this.recentCalls.filter(
      (c) => c.toolName === latest.toolName && (c.sessionId ?? '') === sessionKey,
    );
    const firstFailure = group.findIndex((c) => !c.success);
    if (firstFailure === -1) return null;
    const calls = group.slice(firstFailure);
    if (calls.length < this.minOccurrences) return null;

    const allFailed = calls.every((c) => !c.success);
    const similarity = this.computeGroupSimilarity(calls);
    if (!allFailed && similarity < this.similarityThreshold) return null;

    const toolName = latest.toolName;
    const uncharged = calls.slice(1).filter((c) => !this.chargedIds.has(c.id));
    for (const call of uncharged) this.chargedIds.add(call.id);
    const tokensWasted = estimateTokensWasted(uncharged);
    const alert: ThrashingAlert = {
      toolName,
      occurrences: calls.length,
      windowSize: this.windowSize,
      similarity,
      tokensWastedEstimate: tokensWasted,
      timestamp: Date.now(),
      sessionId: latest.sessionId ?? null,
    };

    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts.shift();
    }
    this.totalAlertsEmitted++;
    this.totalTokensWasted += tokensWasted;
    this.recordSessionBreakdown(alert.sessionId ?? UNKNOWN_SESSION_KEY, tokensWasted);

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

  // Same touch-then-evict LRU shape as TurnCostAttributor's
  // getOrCreateSession — moving a touched key to the end of the Map keeps
  // eviction below a real LRU (evicts the least-recently-touched session,
  // not just the least-recently-created one).
  private recordSessionBreakdown(sessionKey: string, tokensWasted: number): void {
    const existing = this.bySession.get(sessionKey);
    if (existing) {
      this.bySession.delete(sessionKey);
      this.bySession.set(sessionKey, {
        tokensWasted: existing.tokensWasted + tokensWasted,
        alertCount: existing.alertCount + 1,
      });
      return;
    }
    if (this.bySession.size >= DEFAULT_MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest !== undefined) this.bySession.delete(oldest);
    }
    this.bySession.set(sessionKey, { tokensWasted, alertCount: 1 });
  }

  private computeGroupSimilarity(calls: ToolCallRecord[]): number {
    if (calls.length < 2) return 0;

    const inputs = calls.map((c) => this.serializeInput(c));
    let totalSimilarity = 0;
    let comparisons = 0;

    // Compare each pair against the first (reference) input. When the
    // non-hash fields already carry a discriminating signal (Levenshtein
    // similarity < 1 — real parser-populated content differs, e.g. Edit's
    // command text or Bash's command string), trust that signal alone;
    // inputHash contributes nothing here, so a tool with rich parser
    // fields keeps its pre-existing near-identical (not just
    // byte-identical) retry detection.
    //
    // Only when the non-hash fields carry NO signal at all (similarity
    // exactly 1 — every remaining field is identical, which for a
    // parser-less tool means the serialized string reduced to just
    // `{toolName}`) does inputHash's binary equality take over: 1 when
    // both calls' hashes match (a genuine retry), 0 when they don't.
    // Levenshtein-comparing the hash itself creates a false-positive floor
    // there, because unrelated random hex strings still share characters
    // by chance. See serializeInput()'s doc comment.
    const reference = inputs[0];
    const referenceHash = calls[0].inputHash;
    for (let i = 1; i < inputs.length; i++) {
      const levenshteinSimilarity = normalizedLevenshteinSimilarity(reference, inputs[i]);
      const hashSimilarity = referenceHash === calls[i].inputHash ? 1 : 0;
      const combinedSimilarity =
        levenshteinSimilarity === 1 ? hashSimilarity : levenshteinSimilarity;
      totalSimilarity += combinedSimilarity;
      comparisons++;
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  // Excludes per-call metadata that varies even when the actual tool
  // input/arguments are identical (timestamps, ids, sizes, error details) —
  // without stripping these, every call would serialize as "different" and
  // similarity would never detect a genuine repeated-input retry. Also
  // excludes fields that are constant or near-constant *within a session*
  // regardless of how different two calls' real inputs are: cwd and
  // transcriptPath never change within a session, permissionMode rarely
  // does, and extractInputMeta()'s boolean/enum classifier fields
  // (isTestCommand/isBuildCommand/isLintCommand/bashCategory/
  // bashDestructive/bashNetwork) are identical for any two "ordinary" shell
  // commands. Left in place, these dominate the serialized string and pull
  // genuinely distinct calls' similarity up into a false-positive band just
  // above the default 0.8 threshold.
  //
  // inputHash is also excluded here, but NOT dropped from similarity scoring
  // entirely — computeGroupSimilarity() falls back to comparing it by
  // equality, but ONLY when the fields above give it nothing else to work
  // with (see that method's comment for the exact condition). inputHash is
  // a hash of the FULL raw tool input, computed for every call regardless
  // of tool name, unlike the narrowed per-tool fields
  // extractInputMeta()/parseToolSpecificFields() only populate for a known
  // subset of tools; for a tool outside that subset (a third-party MCP
  // tool, ...) the remaining serialized string is just `{toolName}` —
  // identical for every call. Levenshtein-comparing inputHash directly used
  // to compensate for that, but two *unrelated* 16-hex-char hashes still
  // share enough characters by chance for Levenshtein similarity to land
  // above the 0.8 threshold once the boilerplate JSON/toolName padding
  // dilutes the comparison. Equality doesn't have that floor: two unrelated
  // hashes essentially never match (contributes 0), while a genuine repeat
  // still hashes identically (contributes 1) — real-retry detection for
  // parser-less tools is unaffected. Gating this on the fields above having
  // no signal of their own also means a tool WITH rich parser fields (Edit,
  // Bash, ...) never has its near-identical-but-not-byte-identical retry
  // detection capped by an unrelated hash comparison — only a parser-less
  // tool's calls ever reach the gate condition in practice.
  private serializeInput(record: ToolCallRecord): string {
    const {
      id: _id,
      sessionId: _s,
      timestamp: _t,
      durationMs: _d,
      success: _su,
      errorType: _e,
      error: _er,
      inputSizeBytes: _is,
      outputSizeBytes: _os,
      toolUseId: _tu,
      cwd: _cwd,
      transcriptPath: _tp,
      permissionMode: _pm,
      isTestCommand: _itc,
      isBuildCommand: _ibc,
      isLintCommand: _ilc,
      bashCategory: _bc,
      bashDestructive: _bdes,
      bashNetwork: _bnet,
      inputHash: _ih,
      ...rest
    } = record;
    try {
      return JSON.stringify(rest, null, 0);
    } catch {
      return '';
    }
  }
}

// The group's first call is necessary work, so callers pass only the repeats.
function estimateTokensWasted(calls: readonly ToolCallRecord[]): number {
  let totalBytes = 0;
  for (const call of calls) {
    totalBytes += (call.inputSizeBytes ?? 0) + (call.outputSizeBytes ?? 0);
  }
  return Math.ceil(totalBytes / BYTES_PER_TOKEN_ESTIMATE);
}
