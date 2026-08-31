/**
 * Retry/Thrashing Detection — flags a sliding window of recent tool calls
 * where the same tool is either failing repeatedly or being called with
 * near-identical input, both signs of retrying the same broken approach
 * instead of changing strategy. Similarity between calls is measured with
 * Levenshtein distance over each call's serialized (non-metadata) fields,
 * falling back to exact-match equality on a raw input hash only when those
 * fields carry no signal of their own (see computeGroupSimilarity()).
 */

import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
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
// firedKeys grows by one entry per uniquely-fired alert group and is never
// touched again after insertion (unlike bySession, which re-touches an
// existing key on every repeat alert) — a FIFO cap mirroring MAX_ALERTS is
// enough to bound it for the same long-running-process failure mode.
const MAX_FIRED_KEYS = MAX_ALERTS;
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
  // Track which tool+window combos already fired to avoid spamming
  private readonly firedKeys = new Set<string>();

  constructor(options?: RetryDetectorOptions) {
    this.minOccurrences = options?.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.onAlert = options?.onAlert ?? null;
  }

  recordToolCall(record: ToolCallRecord): ThrashingAlert | null {
    this.recentCalls.push(record);

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
    this.firedKeys.clear();
  }

  private checkWindow(): ThrashingAlert | null {
    const window = this.recentCalls.slice(-this.windowSize);
    if (window.length < this.minOccurrences) return null;

    // Group calls by tool name AND session — a shared RetryDetector instance
    // in --local mode processes every concurrently-live session's calls
    // (HookEventProcessor's drainAllSessions), so grouping by tool name
    // alone let two different sessions running the same ordinary command
    // (e.g. both running `npm test`) collapse into one group and risk a
    // false thrashing alert now that serializeInput() no longer includes
    // cwd/transcriptPath to distinguish them.
    const byToolAndSession = new Map<string, ToolCallRecord[]>();
    for (const call of window) {
      const key = `${call.toolName}|${call.sessionId ?? ''}`;
      const arr = byToolAndSession.get(key) ?? [];
      arr.push(call);
      byToolAndSession.set(key, arr);
    }

    for (const calls of byToolAndSession.values()) {
      if (calls.length < this.minOccurrences) continue;
      const toolName = calls[0]!.toolName;

      // Check: either all failed, or inputs are highly similar
      const allFailed = calls.every((c) => !c.success);
      const similarity = this.computeGroupSimilarity(calls);
      const isSimilar = similarity >= this.similarityThreshold;

      if (!allFailed && !isSimilar) continue;

      // Dedupe on the offending group's actual call IDs — not a monotonic
      // counter, which never repeats and so never dedupes: it re-fired for
      // the same unchanged group on every subsequent call, however unrelated.
      // A key built from the group's own call IDs repeats exactly when the
      // group itself hasn't changed, and changes the moment a call ages out
      // of the window or a genuinely new occurrence joins it.
      const dedupeKey = `${toolName}:${calls
        .map((c) => c.id)
        .sort()
        .join(',')}`;
      if (this.firedKeys.has(dedupeKey)) continue;
      this.firedKeys.add(dedupeKey);
      if (this.firedKeys.size > MAX_FIRED_KEYS) {
        const oldest = this.firedKeys.keys().next().value;
        if (oldest !== undefined) this.firedKeys.delete(oldest);
      }

      const tokensWasted = this.estimateTokensWasted(calls);
      const alert: ThrashingAlert = {
        toolName,
        occurrences: calls.length,
        windowSize: this.windowSize,
        similarity,
        tokensWastedEstimate: tokensWasted,
        timestamp: Date.now(),
        sessionId: calls[0]!.sessionId ?? null,
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

    return null;
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

  // The first call in the group is necessary work, not waste — only the
  // repeats after it represent redundant, wasted effort.
  private estimateTokensWasted(calls: ToolCallRecord[]): number {
    let totalBytes = 0;
    for (const call of calls.slice(1)) {
      totalBytes += (call.inputSizeBytes ?? 0) + (call.outputSizeBytes ?? 0);
    }
    return Math.ceil(totalBytes / BYTES_PER_TOKEN_ESTIMATE);
  }
}
