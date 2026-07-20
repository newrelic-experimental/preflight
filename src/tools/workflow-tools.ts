/**
 * MCP tool handlers for workflow analysis.
 *
 * Defines:
 *   - `nr_observe_get_workflow_trace`  — tool call trace for a completed task
 *   - `nr_observe_get_anti_patterns`   — detected anti-patterns
 *   - `nr_observe_get_efficiency_score` — composite efficiency score
 *   - `nr_observe_report_feedback`     — record user quality feedback
 */

import { z } from 'zod';

import type { MetricAggregator } from '../shared/index.js';
import type { TaskDetector, AiCodingTask } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';
import {
  errorResult,
  requireTracker,
  requireAvailable,
  buildToolSet,
  type RegisteredToolSet,
} from './tool-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedbackRecord {
  readonly quality: 'good' | 'bad' | 'neutral';
  readonly notes?: string;
  readonly taskId?: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// FeedbackCollector
// ---------------------------------------------------------------------------

export class FeedbackCollector {
  private records: FeedbackRecord[] = [];
  private lastEmittedIndex = 0;

  record(feedback: Omit<FeedbackRecord, 'timestamp'>): FeedbackRecord {
    const entry: FeedbackRecord = { ...feedback, timestamp: Date.now() };
    this.records.push(entry);
    return entry;
  }

  getRecords(): FeedbackRecord[] {
    return [...this.records];
  }

  emitMetrics(aggregator: MetricAggregator): void {
    for (let i = this.lastEmittedIndex; i < this.records.length; i++) {
      const record = this.records[i]!;
      aggregator.record('ai.feedback.count', 1, { quality: record.quality });
    }
    this.lastEmittedIndex = this.records.length;
  }

  reset(): void {
    this.records = [];
    this.lastEmittedIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return completed tasks plus the current active task (if any). */
function getAllTasks(taskDetector: TaskDetector): AiCodingTask[] {
  const tasks = taskDetector.getCompletedTasks();
  const current = taskDetector.getCurrentTask();
  if (current) tasks.push(current);
  return tasks;
}

// ---------------------------------------------------------------------------
// Tool definitions (for tools/list)
// ---------------------------------------------------------------------------

export const WORKFLOW_TRACE_TOOL = {
  name: 'nr_observe_get_workflow_trace',
  description:
    'Get the complete tool call trace for a task, including sequence, duration, and anti-pattern/efficiency analysis.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'ID of the task to trace (default: most recent completed task)',
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const ANTI_PATTERNS_TOOL = {
  name: 'nr_observe_get_anti_patterns',
  description:
    'Get detected anti-patterns (thrashing, re-reading, stuck loops, blind editing, over-delegation) for the most recent task.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

export const EFFICIENCY_SCORE_TOOL = {
  name: 'nr_observe_get_efficiency_score',
  description:
    'Get the AI coding efficiency score for the most recent task or the session-wide rolling average.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};

export const REPORT_FEEDBACK_TOOL = {
  name: 'nr_observe_report_feedback',
  description:
    'Record user quality feedback for a task. Helps correlate efficiency metrics with perceived quality.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      quality: {
        type: 'string',
        enum: ['good', 'bad', 'neutral'],
        description: 'Quality rating for the task output',
      },
      notes: {
        type: 'string',
        description: 'Optional free-text notes about the task quality',
      },
      task_id: {
        type: 'string',
        description: 'Task ID to attach feedback to (default: most recent)',
      },
    },
    required: ['quality'],
  },
  annotations: { readOnlyHint: false },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleGetWorkflowTrace(
  taskDetector: TaskDetector,
  antiPatternDetector?: AntiPatternDetector,
  efficiencyScorer?: EfficiencyScorer,
  taskId?: string,
) {
  const completed = taskDetector.getCompletedTasks();

  let task: AiCodingTask | undefined;
  if (taskId) {
    task = completed.find((t) => t.taskId === taskId);
  } else {
    task = completed[completed.length - 1];
  }

  if (!task) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { error: 'No matching task found', task_id: taskId ?? null },
            null,
            2,
          ),
        },
      ],
    };
  }

  interface WorkflowTraceEntry {
    seq: number;
    tool: string;
    target: string | null;
    duration_ms: number | null;
    success: boolean;
    exit_code?: unknown;
  }

  const toolCalls = task.toolCalls.map((call, index) => {
    const entry: WorkflowTraceEntry = {
      seq: index + 1,
      tool: call.toolName,
      target: (call.filePath as string | undefined) ?? (call.command as string | undefined) ?? null,
      duration_ms: call.durationMs,
      success: call.success,
    };

    if (call.toolName === 'Bash' && call.exitCode != null) {
      entry.exit_code = call.exitCode;
    }

    return entry;
  });

  const antiPatterns = antiPatternDetector
    ? antiPatternDetector.analyze(task.toolCalls).patterns
    : [];

  const efficiencyScore = efficiencyScorer
    ? efficiencyScorer.computeScore(task, antiPatterns).score
    : null;

  const result = {
    task_id: task.taskId,
    duration_ms: task.durationMs,
    estimated_cost_usd: task.estimatedCostUsd,
    tool_calls: toolCalls,
    anti_patterns: antiPatterns.map((p) => ({
      type: p.type,
      ...(p.file != null && { file: p.file }),
      ...(p.command != null && { command: p.command }),
      ...(p.bashCategory != null && { bash_category: p.bashCategory }),
      ...(p.iterations != null && { iterations: p.iterations }),
      ...(p.readCount != null && { read_count: p.readCount }),
      ...(p.repeatCount != null && { repeat_count: p.repeatCount }),
      ...(p.editCount != null && { edit_count: p.editCount }),
      ...(p.agentCount != null && { agent_count: p.agentCount }),
      suggestion: p.suggestion,
    })),
    efficiency_score: efficiencyScore,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function handleGetAntiPatterns(
  taskDetector: TaskDetector,
  antiPatternDetector: AntiPatternDetector,
) {
  const tasks = getAllTasks(taskDetector);
  const task = tasks[tasks.length - 1];

  if (!task) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify([], null, 2) }],
    };
  }

  const { patterns } = antiPatternDetector.analyze(task.toolCalls);

  const result = patterns.map((p) => ({
    type: p.type,
    ...(p.file != null && { file: p.file }),
    ...(p.command != null && { command: p.command }),
    ...(p.bashCategory != null && { bash_category: p.bashCategory }),
    ...(p.iterations != null && { iterations: p.iterations }),
    ...(p.readCount != null && { read_count: p.readCount }),
    ...(p.repeatCount != null && { repeat_count: p.repeatCount }),
    ...(p.editCount != null && { edit_count: p.editCount }),
    ...(p.agentCount != null && { agent_count: p.agentCount }),
    suggestion: p.suggestion,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function handleGetEfficiencyScore(
  efficiencyScorer: EfficiencyScorer,
  taskDetector?: TaskDetector,
  antiPatternDetector?: AntiPatternDetector,
) {
  // Compute scores on demand for any unscored completed tasks,
  // and always rescore the active task (it grows over time).
  if (taskDetector) {
    const scoredIds = new Set(efficiencyScorer.getScores().map((s) => s.taskId));
    const completedTasks = taskDetector.getCompletedTasks();

    for (const task of completedTasks) {
      if (!scoredIds.has(task.taskId)) {
        const patterns = antiPatternDetector
          ? antiPatternDetector.analyze(task.toolCalls).patterns
          : [];
        efficiencyScorer.computeScore(task, patterns);
      }
    }

    const activeTask = taskDetector.getCurrentTask();
    if (activeTask) {
      const patterns = antiPatternDetector
        ? antiPatternDetector.analyze(activeTask.toolCalls).patterns
        : [];
      efficiencyScorer.updateScore(activeTask, patterns);
    }
  }

  const avg = efficiencyScorer.getSessionAverage();
  const scores = efficiencyScorer.getScores();
  const latest =
    scores.length > 0
      ? scores.reduce((best, s) => (s.timestamp >= best.timestamp ? s : best))
      : null;

  const result = {
    latest: latest
      ? {
          score: latest.score,
          components: latest.components,
          task_id: latest.taskId,
          timestamp: latest.timestamp,
        }
      : null,
    session_average: avg
      ? {
          score: avg.score,
          components: avg.components,
          tasks_scored: scores.length,
        }
      : null,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

const VALID_QUALITY_VALUES = new Set(['good', 'bad', 'neutral']);

export function handleReportFeedback(
  feedbackCollector: FeedbackCollector,
  args: { quality: 'good' | 'bad' | 'neutral'; notes?: string; task_id?: string },
) {
  if (!VALID_QUALITY_VALUES.has(args.quality)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `Invalid quality value: "${args.quality}". Must be one of: good, bad, neutral`,
          }),
        },
      ],
      isError: true,
    };
  }

  const notes = typeof args.notes === 'string' ? args.notes.slice(0, 1024) : undefined;
  const record = feedbackCollector.record({
    quality: args.quality,
    notes,
    taskId: args.task_id,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            recorded: true,
            quality: record.quality,
            task_id: record.taskId ?? null,
            timestamp: record.timestamp,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const FeedbackSchema = z.object({
  quality: z.enum(['good', 'bad', 'neutral']),
  task_id: z.string().optional(),
  notes: z.string().optional(),
});

export interface WorkflowToolsDeps {
  taskDetector?: TaskDetector;
  antiPatternDetector?: AntiPatternDetector;
  efficiencyScorer?: EfficiencyScorer;
  feedbackCollector?: FeedbackCollector;
}

export function registerWorkflowTools(deps: WorkflowToolsDeps): RegisteredToolSet {
  return buildToolSet([
    {
      definition: WORKFLOW_TRACE_TOOL,
      available: !!deps.taskDetector,
      handle: (args) => {
        const check = requireTracker(deps.taskDetector, 'TaskDetector');
        if (!check.ok) return check.result;
        const taskId = args?.task_id as string | undefined;
        return handleGetWorkflowTrace(
          check.value,
          deps.antiPatternDetector,
          deps.efficiencyScorer,
          taskId,
        );
      },
    },
    {
      definition: ANTI_PATTERNS_TOOL,
      available: !!deps.antiPatternDetector && !!deps.taskDetector,
      handle: () => {
        const missing = requireAvailable(
          !!deps.antiPatternDetector && !!deps.taskDetector,
          'AntiPatternDetector or TaskDetector not available',
        );
        if (missing) return missing;
        return handleGetAntiPatterns(deps.taskDetector!, deps.antiPatternDetector!);
      },
    },
    {
      definition: EFFICIENCY_SCORE_TOOL,
      available: !!deps.efficiencyScorer,
      handle: () => {
        const check = requireTracker(deps.efficiencyScorer, 'EfficiencyScorer');
        if (!check.ok) return check.result;
        return handleGetEfficiencyScore(check.value, deps.taskDetector, deps.antiPatternDetector);
      },
    },
    {
      definition: REPORT_FEEDBACK_TOOL,
      available: !!deps.feedbackCollector,
      handle: (args) => {
        const check = requireTracker(deps.feedbackCollector, 'FeedbackCollector');
        if (!check.ok) return check.result;
        try {
          const feedbackArgs = FeedbackSchema.parse(args);
          return handleReportFeedback(check.value, feedbackArgs);
        } catch (err) {
          const message =
            err instanceof z.ZodError
              ? err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
              : String(err);
          return errorResult(`Invalid feedback: ${message}`);
        }
      },
    },
  ]);
}
