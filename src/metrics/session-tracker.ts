/**
 * Session Metrics Aggregation — maintains running aggregates for a coding session.
 *
 * Tracks tool call counts, durations, success rates, file access patterns,
 * and provides both a plain snapshot (for MCP tool responses) and metric
 * emission (for NR ingestion via MetricAggregator).
 */

import { basename } from 'node:path';
import type { MetricAggregator } from '../shared/index.js';
import type { ToolCallRecord } from '../storage/types.js';
import { computePercentile } from './percentile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DurationStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  p95: number;
}

export interface TimelineEntry {
  timestamp: number;
  toolName: string;
  durationMs: number | null;
  success: boolean;
}

export interface SessionMetrics {
  sessionId: string;
  sessionName: string | null;
  sessionStartTime: number;
  sessionDurationMs: number;
  toolCallCount: number;
  toolCallCountByTool: Record<string, number>;
  toolDurationMsByTool: Record<string, DurationStats>;
  toolSuccessRate: number | null;
  toolSuccessRateByTool: Record<string, number>;
  toolErrorCount: number;
  toolErrorsByType: Record<string, number>;
  uniqueFilesRead: number;
  uniqueFilesWritten: number;
  bashCommandsRun: number;
  bashExitCodes: Record<string, number>;
  /** Per-bash-category call counts (e.g. git, test-runner, build). Only populated for Bash tool calls. */
  bashCallsByCategory: Record<string, number>;
  searchQueries: number;
  toolCallTimeline: TimelineEntry[];
  /** True when the timeline was capped at MAX_TIMELINE_ENTRIES; callers should not assume they have the full history. */
  timelineTruncated: boolean;
  /** Lifetime total of timeline entries, including those dropped by the cap. */
  timelineEntryCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TIMELINE_ENTRIES = 10_000;

export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return computePercentile(sorted, 0.95) ?? 0;
}

export function computeDurationStats(durations: number[]): DurationStats {
  if (durations.length === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, p95: 0 };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const d of durations) {
    sum += d;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return {
    count: durations.length,
    sum,
    min,
    max,
    p95: computeP95(durations),
  };
}

// ---------------------------------------------------------------------------
// SessionTracker
// ---------------------------------------------------------------------------

export class SessionTracker {
  private sessionId: string;
  private sessionName: string | null = null;
  private sessionStartTime: number;

  private toolCallCount = 0;
  private toolErrorCount = 0;
  private successCount = 0;
  private bashCommandsRun = 0;
  private searchQueries = 0;

  private readonly toolCallCountByTool = new Map<string, number>();
  private readonly toolDurationsByTool = new Map<string, number[]>();
  private readonly toolSuccessByTool = new Map<string, { success: number; total: number }>();
  private readonly toolErrorsByType = new Map<string, number>();
  private readonly filesRead = new Set<string>();
  private readonly filesWritten = new Set<string>();
  private readonly bashExitCodes = new Map<number, number>();
  private readonly bashCallsByCategory = new Map<string, number>();
  private timeline: TimelineEntry[] = [];
  private timelineEntryCount = 0;

  constructor(sessionId: string) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      // The MCP no longer fabricates session_ids. Callers must pass the
      // resolved Claude Code session_id (or a real UUID for tests).
      throw new Error('SessionTracker requires a non-empty sessionId');
    }
    this.sessionId = sessionId;
    this.sessionStartTime = Date.now();
  }

  recordToolCall(record: ToolCallRecord): void {
    this.toolCallCount++;

    // Derive session name from cwd; prefer a later, more meaningful name if the
    // current one is a degenerate system directory (tmp, var, usr, etc.).
    const DEGENERATE_NAMES = new Set(['tmp', 'temp', 'var', 'usr', 'opt', 'home', '.', '..', '']);
    if (typeof record.cwd === 'string' && record.cwd.length > 0) {
      const name = basename(record.cwd);
      if (name.length > 0 && name !== '.' && name !== '..') {
        if (this.sessionName === null || DEGENERATE_NAMES.has(this.sessionName.toLowerCase())) {
          this.sessionName = name;
        }
      }
    }

    // Per-tool count
    const tool = record.toolName;
    this.toolCallCountByTool.set(tool, (this.toolCallCountByTool.get(tool) ?? 0) + 1);

    // Duration tracking
    if (record.durationMs !== null && record.durationMs !== undefined) {
      const durations = this.toolDurationsByTool.get(tool);
      if (durations) {
        if (durations.length < 500) durations.push(record.durationMs);
      } else {
        this.toolDurationsByTool.set(tool, [record.durationMs]);
      }
    }

    // Success/failure tracking
    const successEntry = this.toolSuccessByTool.get(tool) ?? { success: 0, total: 0 };
    successEntry.total++;
    if (record.success) {
      successEntry.success++;
      this.successCount++;
    } else {
      this.toolErrorCount++;
      if (record.errorType) {
        this.toolErrorsByType.set(
          record.errorType,
          (this.toolErrorsByType.get(record.errorType) ?? 0) + 1,
        );
      }
    }
    this.toolSuccessByTool.set(tool, successEntry);

    // File tracking (uses tool-specific fields from parsers)
    const filePath = record.filePath as string | undefined;
    if (filePath) {
      if (tool === 'Read') {
        this.filesRead.add(filePath);
      } else if (tool === 'Write' || tool === 'Edit') {
        this.filesWritten.add(filePath);
      }
    }

    // Bash tracking
    if (tool === 'Bash') {
      this.bashCommandsRun++;
      const exitCode = record.exitCode as number | undefined;
      if (exitCode != null) {
        this.bashExitCodes.set(exitCode, (this.bashExitCodes.get(exitCode) ?? 0) + 1);
      }
      const category = record.bashCategory as string | undefined;
      if (typeof category === 'string' && category.length > 0) {
        this.bashCallsByCategory.set(category, (this.bashCallsByCategory.get(category) ?? 0) + 1);
      }
    }

    // Search tracking
    if (tool === 'Grep' || tool === 'Glob') {
      this.searchQueries++;
    }

    // Timeline (capped); always increment the lifetime counter.
    this.timelineEntryCount++;
    if (this.timeline.length < MAX_TIMELINE_ENTRIES) {
      this.timeline.push({
        timestamp: record.timestamp,
        toolName: tool,
        durationMs: record.durationMs,
        success: record.success,
      });
    }
  }

  getMetrics(): SessionMetrics {
    // Convert Maps to plain objects
    const toolCallCountByTool: Record<string, number> = {};
    for (const [tool, count] of this.toolCallCountByTool) {
      toolCallCountByTool[tool] = count;
    }

    const toolDurationMsByTool: Record<string, DurationStats> = {};
    for (const [tool, durations] of this.toolDurationsByTool) {
      toolDurationMsByTool[tool] = computeDurationStats(durations);
    }

    const toolSuccessRateByTool: Record<string, number> = {};
    for (const [tool, entry] of this.toolSuccessByTool) {
      toolSuccessRateByTool[tool] = entry.total > 0 ? entry.success / entry.total : 1;
    }

    const toolErrorsByType: Record<string, number> = {};
    for (const [type, count] of this.toolErrorsByType) {
      toolErrorsByType[type] = count;
    }

    const bashExitCodes: Record<string, number> = {};
    for (const [code, count] of this.bashExitCodes) {
      bashExitCodes[String(code)] = count;
    }

    const bashCallsByCategory: Record<string, number> = {};
    for (const [category, count] of this.bashCallsByCategory) {
      bashCallsByCategory[category] = count;
    }

    const overallSuccessRate =
      this.toolCallCount > 0 ? this.successCount / this.toolCallCount : null;

    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      sessionStartTime: this.sessionStartTime,
      sessionDurationMs: Date.now() - this.sessionStartTime,
      toolCallCount: this.toolCallCount,
      toolCallCountByTool,
      toolDurationMsByTool,
      toolSuccessRate: overallSuccessRate,
      toolSuccessRateByTool,
      toolErrorCount: this.toolErrorCount,
      toolErrorsByType,
      uniqueFilesRead: this.filesRead.size,
      uniqueFilesWritten: this.filesWritten.size,
      bashCommandsRun: this.bashCommandsRun,
      bashExitCodes,
      bashCallsByCategory,
      searchQueries: this.searchQueries,
      toolCallTimeline: [...this.timeline],
      timelineTruncated: this.timelineEntryCount > this.timeline.length,
      timelineEntryCount: this.timelineEntryCount,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    // Per-tool metrics
    for (const [tool, count] of this.toolCallCountByTool) {
      aggregator.record('ai.tool.call_count', count, { tool });
    }

    for (const [tool, durations] of this.toolDurationsByTool) {
      for (const d of durations) {
        aggregator.record('ai.tool.duration_ms', d, { tool });
      }
    }

    for (const [tool, entry] of this.toolSuccessByTool) {
      const rate = entry.total > 0 ? entry.success / entry.total : 1;
      aggregator.record('ai.tool.success_rate', rate, { tool });
    }

    // Per-bash-category breakdown — emitted separately from generic tool
    // counts so dashboards can split git vs test-runner vs build vs ...
    for (const [category, count] of this.bashCallsByCategory) {
      aggregator.record('ai.bash.call_count', count, { category });
    }

    // Session-level metrics
    aggregator.record('ai.session.duration_ms', Date.now() - this.sessionStartTime);
    aggregator.record('ai.session.unique_files_read', this.filesRead.size);
    aggregator.record('ai.session.unique_files_written', this.filesWritten.size);
  }

  /** Update the session ID in place without clearing any accumulated metrics. */
  adoptSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('SessionTracker.adoptSessionId() requires a non-empty sessionId');
    }
    this.sessionId = sessionId;
  }

  reset(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('SessionTracker.reset() requires a non-empty sessionId');
    }
    this.sessionId = sessionId;
    this.sessionName = null;
    this.sessionStartTime = Date.now();
    this.toolCallCount = 0;
    this.toolErrorCount = 0;
    this.successCount = 0;
    this.bashCommandsRun = 0;
    this.searchQueries = 0;
    this.toolCallCountByTool.clear();
    this.toolDurationsByTool.clear();
    this.toolSuccessByTool.clear();
    this.toolErrorsByType.clear();
    this.filesRead.clear();
    this.filesWritten.clear();
    this.bashExitCodes.clear();
    this.bashCallsByCategory.clear();
    this.timeline = [];
    this.timelineEntryCount = 0;
  }
}
