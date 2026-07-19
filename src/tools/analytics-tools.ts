/**
 * MCP tool handlers for new metric trackers.
 *
 * Defines and handles:
 *   - nr_observe_get_context_efficiency — context window efficiency metrics
 *   - nr_observe_get_latency_percentiles — tool call latency percentiles
 *   - nr_observe_get_task_completion_rate — task lifecycle metrics
 *   - nr_observe_get_model_usage — per-model usage and efficiency
 *   - nr_observe_get_context_tracking — per-turn context token growth and breakdown
 */

import type { ContextWindowTracker } from '../metrics/context-window-tracker.js';
import type { ContextTrackerRegistry } from '../metrics/context-tracker.js';
import type { LatencyTracker } from '../metrics/latency-tracker.js';
import type { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

export const CONTEXT_EFFICIENCY_TOOL = {
  name: 'nr_observe_get_context_efficiency',
  description:
    'Get context window efficiency metrics: unique vs. repeated file reads, repeated-read ratio, and top re-read files. A high ratio suggests the model is losing context.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const LATENCY_PERCENTILES_TOOL = {
  name: 'nr_observe_get_latency_percentiles',
  description:
    'Get p50/p95/p99 latency percentiles for tool calls, broken down by tool type. Use to identify which tools are slowest in the current session.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const TASK_COMPLETION_TOOL = {
  name: 'nr_observe_get_task_completion_rate',
  description:
    'Get task lifecycle metrics: completed task count, average task duration, and average tool calls per task.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const MODEL_USAGE_TOOL = {
  name: 'nr_observe_get_model_usage',
  description:
    'Get per-model usage statistics: request counts, token totals, cost, and cost-per-output-token efficiency ratios. Identifies the most-used and most cost-efficient model.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const CONTEXT_TRACKING_TOOL = {
  name: 'nr_observe_get_context_tracking',
  description:
    'Get context window tracking: per-turn token growth, category breakdown (System/Tools/User/Assistant), fill percentage, and per-tool output contribution. Shows which tools consume the most context.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetContextEfficiency(tracker: ContextWindowTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetLatencyPercentiles(tracker: LatencyTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetTaskCompletionRate(
  tracker: TaskCompletionTracker,
  _taskDetector?: TaskDetector,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetModelUsage(tracker: ModelUsageTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetContextTracking(tracker: ContextTrackerRegistry): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}
