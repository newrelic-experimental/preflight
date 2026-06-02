import { createLogger } from '../shared/index.js';

const logger = createLogger('alert-snapshot-collector');

// ---------------------------------------------------------------------------
// Snapshot type — owns the shape that LocalAlertEngine.evaluate() consumes.
// (Re-exported from local-alert-engine.ts to keep Phase 1 imports stable.)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the current observable state used by the engine to evaluate
 * rules. Built by AlertSnapshotCollector on each evaluation tick.
 *
 * Window semantics:
 * - `antiPatterns` is one entry per (type, windowMs) tuple. Engine matches
 *   by exact `windowMs`, so two rules with different windows over the same
 *   pattern type each get their own count entry.
 * - `toolFailures` is one entry per (tool, windowMs) tuple, same matching
 *   rule.
 *
 * Cost is currently session-cumulative (not a rolling window). v1.1 ships
 * with this approximation; v1.2 will add a true rolling-hour cost window.
 */
export interface AlertSnapshot {
  readonly timestamp: number;
  readonly cost: { sessionUsd: number; todayUsd: number; weekUsd: number };
  readonly efficiency: { score: number | null };
  readonly antiPatterns: ReadonlyArray<{
    type: string;
    count: number;
    windowMs: number;
  }>;
  readonly latency: ReadonlyArray<{
    tool: string;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
  readonly toolFailures: ReadonlyArray<{
    tool: string;
    failurePct: number;
    windowMs: number;
  }>;
  readonly budgetThresholds?: ReadonlyArray<{
    period: 'session' | 'daily' | 'weekly';
    thresholdPct: 50 | 80 | 100;
    spentUsd: number;
    budgetUsd: number;
  }>;
}

// ---------------------------------------------------------------------------
// Collector deps + types
// ---------------------------------------------------------------------------

export interface AlertSnapshotCollectorDeps {
  readonly costTracker?: {
    getMetrics(): { sessionTotalCostUsd?: number | null };
  };
  /**
   * Thunk that returns the rolling cost forecast snapshot. Currently unused
   * by the snapshot path (kept for symmetry with index.ts wiring); v1.2
   * may consume it for true rolling-window cost.
   */
  readonly costForecast?: () => unknown;
  readonly efficiencyScorer?: {
    /**
     * Returns the current efficiency score in [0, 1], or `null` if there
     * are no scored tasks yet. The collector adapts whatever the
     * efficiency scorer exposes via this small interface so the tracker
     * itself doesn't need a new public method.
     */
    getCurrentScore(): number | null;
  };
  readonly antiPatternDetector?: {
    getCurrentPatterns(): readonly { type: string }[];
  };
  readonly latencyTracker?: {
    getMetrics(): {
      byTool: Readonly<
        Record<string, { p50?: number; p95?: number; p99?: number } | null>
      >;
    };
  };
  readonly sessionTracker?: {
    getMetrics(): {
      toolCalls?: ReadonlyArray<{
        tool?: string;
        toolName?: string;
        success?: boolean;
      }>;
    };
  };
  readonly clock?: () => number;
}

export interface SnapshotWindowSpec {
  readonly kind: 'antipattern' | 'tool-failure';
  /**
   * Free-form key for the window. For `antipattern`, the key is the
   * pattern type (or `'*'` for "any type"). For `tool-failure`, the key is
   * the tool name.
   */
  readonly key: string;
  readonly windowMs: number;
}

interface ToolCallEntry {
  readonly tool: string;
  readonly success: boolean;
  readonly ts: number;
}

interface AntiPatternEntry {
  readonly type: string;
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUFFER_ENTRIES = 5000;
/**
 * Default prune horizon (30 minutes). When `snapshot()` is called with no
 * window specs, entries older than this are pruned so the buffers don't
 * grow unbounded between evaluations.
 */
const DEFAULT_MAX_WINDOW_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// AlertSnapshotCollector
// ---------------------------------------------------------------------------

export class AlertSnapshotCollector {
  private readonly deps: AlertSnapshotCollectorDeps;
  private readonly clock: () => number;
  // Both buffers are kept sorted by ts (callers typically push monotonically
  // increasing timestamps). If a stale-timestamped entry sneaks in, the
  // window queries below still work because we filter by `ts >= cutoff`.
  private readonly toolCallEvents: ToolCallEntry[] = [];
  private readonly antiPatternEvents: AntiPatternEntry[] = [];

  constructor(deps: AlertSnapshotCollectorDeps = {}) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * Push a tool call observation onto the rolling buffer. Caller supplies
   * the timestamp (typically `Date.now()` at the time the hook fired).
   */
  recordToolCall(record: {
    toolName: string;
    success: boolean;
    ts: number;
  }): void {
    this.toolCallEvents.push({
      tool: record.toolName,
      success: record.success,
      ts: record.ts,
    });
    this.trimBuffer(this.toolCallEvents);
  }

  /**
   * Push an anti-pattern observation onto the rolling buffer.
   */
  recordAntiPattern(observation: { type: string; ts: number }): void {
    this.antiPatternEvents.push({
      type: observation.type,
      ts: observation.ts,
    });
    this.trimBuffer(this.antiPatternEvents);
  }

  /**
   * Build a snapshot. The longest window any rule can span is 30 minutes
   * by default; older buffer entries are pruned during the call.
   *
   * Returns one entry per requested (type, windowMs) for anti-patterns and
   * (tool, windowMs) for tool failures.
   */
  snapshot(now: number, windows: ReadonlyArray<SnapshotWindowSpec>): AlertSnapshot {
    // Determine the longest window so we know how far back to keep events.
    let maxWindowMs = DEFAULT_MAX_WINDOW_MS;
    for (const w of windows) {
      if (w.windowMs > maxWindowMs) maxWindowMs = w.windowMs;
    }
    const cutoff = now - maxWindowMs;
    this.pruneOlderThan(this.toolCallEvents, cutoff);
    this.pruneOlderThan(this.antiPatternEvents, cutoff);

    const antiPatterns = this.buildAntiPatternCounts(windows, now);
    const toolFailures = this.buildToolFailureCounts(windows, now);

    return {
      timestamp: now,
      cost: this.readCost(),
      efficiency: { score: this.readEfficiencyScore() },
      antiPatterns,
      latency: this.readLatency(),
      toolFailures,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — counts
  // ---------------------------------------------------------------------------

  private buildAntiPatternCounts(
    windows: ReadonlyArray<SnapshotWindowSpec>,
    now: number,
  ): ReadonlyArray<{ type: string; count: number; windowMs: number }> {
    const out: { type: string; count: number; windowMs: number }[] = [];
    // Deduplicate (type, windowMs) so the same window spec twice doesn't
    // produce two entries.
    const seen = new Set<string>();
    for (const w of windows) {
      if (w.kind !== 'antipattern') continue;
      const seenKey = `${w.key}:${w.windowMs}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      const cutoff = now - w.windowMs;
      let count = 0;
      for (const ev of this.antiPatternEvents) {
        if (ev.ts < cutoff) continue;
        if (w.key === '*' || ev.type === w.key) count++;
      }
      out.push({ type: w.key, count, windowMs: w.windowMs });
    }
    return out;
  }

  private buildToolFailureCounts(
    windows: ReadonlyArray<SnapshotWindowSpec>,
    now: number,
  ): ReadonlyArray<{ tool: string; failurePct: number; windowMs: number }> {
    const out: { tool: string; failurePct: number; windowMs: number }[] = [];
    const seen = new Set<string>();
    for (const w of windows) {
      if (w.kind !== 'tool-failure') continue;
      const seenKey = `${w.key}:${w.windowMs}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      const cutoff = now - w.windowMs;
      let total = 0;
      let failures = 0;
      for (const ev of this.toolCallEvents) {
        if (ev.ts < cutoff) continue;
        if (w.key !== '*' && ev.tool !== w.key) continue;
        total++;
        if (!ev.success) failures++;
      }
      // No samples → 0% (rather than NaN). Rules can compare; absence of
      // calls is "everything's fine."
      const failurePct = total === 0 ? 0 : (failures / total) * 100;
      out.push({ tool: w.key, failurePct, windowMs: w.windowMs });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internal — tracker reads (defensive: missing deps yield neutral values)
  // ---------------------------------------------------------------------------

  private readCost(): { sessionUsd: number; todayUsd: number; weekUsd: number } {
    try {
      const m = this.deps.costTracker?.getMetrics();
      const sessionUsd = m?.sessionTotalCostUsd ?? 0;
      // v1.1 only wires sessionUsd; today/week are zero placeholders. Once
      // the daily/weekly cost trackers expose APIs the collector can consume,
      // these can be filled in without rule changes.
      return { sessionUsd: sessionUsd ?? 0, todayUsd: 0, weekUsd: 0 };
    } catch (err) {
      logger.warn('costTracker.getMetrics() threw — defaulting to 0', {
        error: String(err),
      });
      return { sessionUsd: 0, todayUsd: 0, weekUsd: 0 };
    }
  }

  private readEfficiencyScore(): number | null {
    try {
      const score = this.deps.efficiencyScorer?.getCurrentScore?.();
      return typeof score === 'number' ? score : null;
    } catch (err) {
      logger.warn('efficiencyScorer.getCurrentScore() threw', {
        error: String(err),
      });
      return null;
    }
  }

  private readLatency(): ReadonlyArray<{
    tool: string;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }> {
    try {
      const metrics = this.deps.latencyTracker?.getMetrics();
      if (!metrics) return [];
      const out: {
        tool: string;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
      }[] = [];
      for (const [tool, percentiles] of Object.entries(metrics.byTool)) {
        if (!percentiles) continue;
        // Only emit when at least p95 is available; surface 0 for any
        // missing percentile (rule comparator handles 0 sensibly via
        // `above` / `above_or_equals`).
        if (typeof percentiles.p95 === 'number') {
          out.push({
            tool,
            p50Ms: typeof percentiles.p50 === 'number' ? percentiles.p50 : 0,
            p95Ms: percentiles.p95,
            p99Ms: typeof percentiles.p99 === 'number' ? percentiles.p99 : 0,
          });
        }
      }
      return out;
    } catch (err) {
      logger.warn('latencyTracker.getMetrics() threw', { error: String(err) });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — buffer maintenance
  // ---------------------------------------------------------------------------

  private trimBuffer<T>(buf: T[]): void {
    // Hard cap so an idle process can't grow buffers without bound. Drop
    // the oldest entries first.
    if (buf.length > MAX_BUFFER_ENTRIES) {
      buf.splice(0, buf.length - MAX_BUFFER_ENTRIES);
    }
  }

  private pruneOlderThan<T extends { ts: number }>(buf: T[], cutoff: number): void {
    if (buf.length === 0) return;
    let removeUntil = 0;
    while (removeUntil < buf.length && buf[removeUntil]!.ts < cutoff) {
      removeUntil++;
    }
    if (removeUntil > 0) buf.splice(0, removeUntil);
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** @internal — for tests only. Returns the current buffer sizes. */
  bufferSizes(): { toolCalls: number; antiPatterns: number } {
    return {
      toolCalls: this.toolCallEvents.length,
      antiPatterns: this.antiPatternEvents.length,
    };
  }

  /** @internal — for tests only. Returns the configured clock reading. */
  now(): number {
    return this.clock();
  }
}
