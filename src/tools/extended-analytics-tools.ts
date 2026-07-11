/**
 * MCP tool handlers for extended metric trackers (Phase 2).
 *
 * Defines and handles:
 *   - nr_observe_get_retry_alerts — thrashing/retry detection alerts
 *   - nr_observe_get_context_composition — per-turn token breakdown by category
 *   - nr_observe_get_latency_decomposition — time decomposition (LLM vs tool vs overhead)
 *   - nr_observe_get_decision_tree — decision branch analysis with post-mortem
 *   - nr_observe_get_instruction_drift — prompt variant correlations and drift
 *   - nr_observe_get_tool_selection_score — tool selection quality score
 *   - nr_observe_get_quality_proxy — quality signal tracking and degradation
 *   - nr_observe_get_api_failures — API failure events and model reliability
 */

import type { ToolCallRecord } from '../storage/types.js';
import type { RetryDetector } from '../metrics/retry-detector.js';
import type { ContextCompositionTracker } from '../metrics/context-composition-tracker.js';
import type { LatencyDecompositionTracker } from '../metrics/latency-decomposition.js';
import type { DecisionTracker } from '../metrics/decision-tracker.js';
import { DECISION_TREE_REASONING_NOTE } from '../metrics/decision-tracker.js';
import type { InstructionDriftTracker } from '../metrics/instruction-drift-tracker.js';
import type { ToolSelectionScorer } from '../metrics/tool-selection-scorer.js';
import type { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import type { ApiFailureTracker } from '../metrics/api-failure-tracker.js';

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

export const RETRY_ALERTS_TOOL = {
  name: 'nr_observe_get_retry_alerts',
  description:
    'Get thrashing/retry detection alerts: repeated failures or highly similar inputs within a sliding window. Identifies when the agent is stuck in a loop.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const CONTEXT_COMPOSITION_TOOL = {
  name: 'nr_observe_get_context_composition',
  description:
    "Get per-turn token breakdown by category (system prompt, conversation history, tool results, injected files). Shows context window fill percentage and dominance alerts. LIMITATION: system_prompt and injected_file_content are always 0 -- the model API's aggregate usage counts have no breakdown by content category (see the note field in the response).",
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const LATENCY_DECOMPOSITION_TOOL = {
  name: 'nr_observe_get_latency_decomposition',
  description:
    'Get latency decomposition: how much time is spent in LLM API calls vs tool execution vs overhead, with p50/p95 percentiles for each component.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const DECISION_TREE_TOOL = {
  name: 'nr_observe_get_decision_tree',
  description:
    'Get decision branch analysis: rule-based decision labeling and action tagging for triggered branches (recovery, retry, delegation), with outcome tagging. Includes post-mortem of failure chains and longest failure streak. LIMITATION: the reasoning field is a fixed rule-based label, not extracted model chain-of-thought, and branches are only recorded on 3 narrow triggers rather than every turn (see the note field in the response).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      post_mortem: {
        type: 'boolean',
        description: 'If true, return only failure-zone branches for debugging (default: false)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const INSTRUCTION_DRIFT_TOOL = {
  name: 'nr_observe_get_instruction_drift',
  description:
    'Get instruction/prompt drift analysis: tracks how CLAUDE.md or system prompt changes correlate with session outcomes (success rate, token usage, thrashing).',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const TOOL_SELECTION_SCORE_TOOL = {
  name: 'nr_observe_get_tool_selection_score',
  description:
    'Get tool selection quality score: evaluates efficiency of tool usage by detecting redundant reads, repeated failures, and unused large outputs. Score 0-1 where 1 is perfect.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const QUALITY_PROXY_TOOL = {
  name: 'nr_observe_get_quality_proxy',
  description:
    'Get quality proxy metrics: diff apply rate, test pass rate, backtrack count, self-correction count, and degradation detection over the session lifetime.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const API_FAILURES_TOOL = {
  name: 'nr_observe_get_api_failures',
  description:
    "Get API failure tracking: per-model reliability scorecards, tokens lost, cost impact, throttle alerts, and mean time to recovery. LIMITATION: model-API-level failure data is not observable in Preflight's current architecture (see the note field in the response) — this tool currently always returns empty/zero metrics.",
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetRetryAlerts(tracker: RetryDetector): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetContextComposition(tracker: ContextCompositionTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetLatencyDecomposition(tracker: LatencyDecompositionTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetDecisionTree(
  tracker: DecisionTracker,
  postMortem: boolean,
): { content: Array<{ type: 'text'; text: string }> } {
  if (postMortem) {
    const branches = tracker.getPostMortem();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { postMortem: branches, note: DECISION_TREE_REASONING_NOTE },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetInstructionDrift(tracker: InstructionDriftTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetToolSelectionScore(
  scorer: ToolSelectionScorer,
  toolCalls: readonly ToolCallRecord[],
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = scorer.scoreSession(toolCalls);
  return { content: [{ type: 'text' as const, text: JSON.stringify(metrics, null, 2) }] };
}

export function handleGetQualityProxy(tracker: QualityProxyTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}

export function handleGetApiFailures(tracker: ApiFailureTracker): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }],
  };
}
