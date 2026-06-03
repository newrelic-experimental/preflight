import type { MetricAggregator } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QualitySignal =
  | 'diff_applied_clean'
  | 'diff_failed'
  | 'test_pass'
  | 'test_fail'
  | 'backtrack'
  | 'self_correction';

export interface QualityEvent {
  readonly signal: QualitySignal;
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly toolName: string;
}

export interface TurnQualityBucket {
  readonly turnRange: string;
  readonly totalSignals: number;
  readonly positiveSignals: number;
  readonly negativeSignals: number;
  readonly qualityRatio: number | null;
}

export interface QualityProxyMetrics {
  readonly totalSignals: number;
  readonly diffApplyRate: number | null;
  readonly testPassRate: number | null;
  readonly backtrackCount: number;
  readonly selfCorrectionCount: number;
  readonly qualityByTurnBucket: readonly TurnQualityBucket[];
  readonly degradationDetected: boolean;
  readonly events: readonly QualityEvent[];
}

export interface QualityProxyOptions {
  readonly bucketSize?: number;
  readonly maxEvents?: number;
  readonly degradationThreshold?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BUCKET_SIZE = 10;
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_DEGRADATION_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// QualityProxyTracker
// ---------------------------------------------------------------------------

export class QualityProxyTracker {
  private readonly bucketSize: number;
  private readonly maxEvents: number;
  private readonly degradationThreshold: number;

  private turnCounter = 0;
  private readonly events: QualityEvent[] = [];
  private lastEditFile: string | null = null;
  private lastEditTurn = 0;

  constructor(options?: QualityProxyOptions) {
    this.bucketSize = options?.bucketSize ?? DEFAULT_BUCKET_SIZE;
    this.maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.degradationThreshold = options?.degradationThreshold ?? DEFAULT_DEGRADATION_THRESHOLD;
  }

  recordToolCall(record: ToolCallRecord): void {
    this.turnCounter++;
    const turn = this.turnCounter;

    // Detect self-correction BEFORE updating lastEditFile/lastEditTurn
    if ((record.toolName === 'Edit' || record.toolName === 'Write') && this.lastEditFile !== null) {
      const filePath = record.filePath as string | undefined;
      if (filePath === this.lastEditFile && turn - this.lastEditTurn <= 3) {
        const recentFailure = this.events.some(
          (e) => e.signal === 'test_fail' && e.turnNumber > this.lastEditTurn && e.turnNumber < turn,
        );
        if (recentFailure) {
          this.addEvent('self_correction', turn, record.toolName);
        }
      }
    }

    // Detect backtrack: Read of a file we recently edited
    if (record.toolName === 'Read' && this.lastEditFile !== null) {
      const filePath = record.filePath as string | undefined;
      if (filePath === this.lastEditFile && turn - this.lastEditTurn <= 2) {
        this.addEvent('backtrack', turn, record.toolName);
      }
    }

    if (record.toolName === 'Edit' || record.toolName === 'Write') {
      if (record.success) {
        this.addEvent('diff_applied_clean', turn, record.toolName);
      } else {
        this.addEvent('diff_failed', turn, record.toolName);
      }
      this.lastEditFile = (record.filePath as string) ?? null;
      this.lastEditTurn = turn;
    }

    if (record.toolName === 'Bash') {
      if (record.isTestCommand) {
        if (record.success) {
          this.addEvent('test_pass', turn, record.toolName);
        } else {
          this.addEvent('test_fail', turn, record.toolName);
        }
      }
    }
  }

  getMetrics(): QualityProxyMetrics {
    const diffApplied = this.events.filter((e) => e.signal === 'diff_applied_clean').length;
    const diffFailed = this.events.filter((e) => e.signal === 'diff_failed').length;
    const testPass = this.events.filter((e) => e.signal === 'test_pass').length;
    const testFail = this.events.filter((e) => e.signal === 'test_fail').length;
    const backtrackCount = this.events.filter((e) => e.signal === 'backtrack').length;
    const selfCorrectionCount = this.events.filter((e) => e.signal === 'self_correction').length;

    const totalDiffs = diffApplied + diffFailed;
    const totalTests = testPass + testFail;

    const buckets = this.computeTurnBuckets();
    const degradationDetected = this.detectDegradation(buckets);

    return {
      totalSignals: this.events.length,
      diffApplyRate: totalDiffs > 0 ? Math.round((diffApplied / totalDiffs) * 1000) / 1000 : null,
      testPassRate: totalTests > 0 ? Math.round((testPass / totalTests) * 1000) / 1000 : null,
      backtrackCount,
      selfCorrectionCount,
      qualityByTurnBucket: buckets,
      degradationDetected,
      events: this.events,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const metrics = this.getMetrics();
    if (metrics.diffApplyRate !== null) {
      aggregator.record('ai.quality.diff_apply_rate', metrics.diffApplyRate);
    }
    if (metrics.testPassRate !== null) {
      aggregator.record('ai.quality.test_pass_rate', metrics.testPassRate);
    }
    aggregator.record('ai.quality.backtrack_count', metrics.backtrackCount);
    aggregator.record('ai.quality.self_correction_count', metrics.selfCorrectionCount);
    if (metrics.degradationDetected) {
      aggregator.record('ai.quality.degradation_detected', 1);
    }
  }

  reset(_sessionId: string): void {
    this.turnCounter = 0;
    this.events.length = 0;
    this.lastEditFile = null;
    this.lastEditTurn = 0;
  }

  private addEvent(signal: QualitySignal, turnNumber: number, toolName: string): void {
    this.events.push({ signal, turnNumber, timestamp: Date.now(), toolName });
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  private computeTurnBuckets(): TurnQualityBucket[] {
    if (this.events.length === 0) return [];

    const maxTurn = Math.max(...this.events.map((e) => e.turnNumber));
    const buckets: TurnQualityBucket[] = [];

    for (let start = 1; start <= maxTurn; start += this.bucketSize) {
      const end = start + this.bucketSize - 1;
      const inBucket = this.events.filter(
        (e) => e.turnNumber >= start && e.turnNumber <= end,
      );

      const positive = inBucket.filter(
        (e) => e.signal === 'diff_applied_clean' || e.signal === 'test_pass',
      ).length;
      const negative = inBucket.filter(
        (e) => e.signal === 'diff_failed' || e.signal === 'test_fail' || e.signal === 'backtrack',
      ).length;
      const total = positive + negative;

      buckets.push({
        turnRange: `${start}-${end}`,
        totalSignals: inBucket.length,
        positiveSignals: positive,
        negativeSignals: negative,
        qualityRatio: total > 0 ? Math.round((positive / total) * 1000) / 1000 : null,
      });
    }

    return buckets;
  }

  private detectDegradation(buckets: readonly TurnQualityBucket[]): boolean {
    if (buckets.length < 3) return false;

    // Compare first third vs last third of buckets
    const third = Math.floor(buckets.length / 3);
    const earlyBuckets = buckets.slice(0, third);
    const lateBuckets = buckets.slice(-third);

    const earlyRatio = this.averageQualityRatio(earlyBuckets);
    const lateRatio = this.averageQualityRatio(lateBuckets);

    if (earlyRatio === null || lateRatio === null) return false;

    const drop = earlyRatio - lateRatio;
    return drop >= this.degradationThreshold;
  }

  private averageQualityRatio(buckets: readonly TurnQualityBucket[]): number | null {
    const ratios = buckets
      .map((b) => b.qualityRatio)
      .filter((r): r is number => r !== null);
    if (ratios.length === 0) return null;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }
}
