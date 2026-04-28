# Implementation Plan: New Metric Trackers

**Roadmap item:** [06 — New Metric Trackers](../../ROADMAP.md#6-new-metric-trackers)
**Effort estimate:** ~2 days (all four trackers)
**Prerequisites:** Read the existing tracker implementations before starting.

---

## Background reading

Read these files end-to-end before starting:

- `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts` — the most structurally complete tracker; use as the template
- `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts` — shows how a tracker maintains running state
- `packages/nr-ai-mcp-server/src/metrics/task-detector.ts` — `AiCodingTask` type; used by TaskCompletionTracker
- `packages/nr-ai-mcp-server/src/storage/types.ts` — `ToolCallRecord` type
- `packages/nr-ai-mcp-server/src/tools/session-stats.ts` — `registerTools()` and `RegisterToolsOptions`; all new tools register here
- `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` — how to emit new event/metric types

---

## Goal

Four new tracker classes, each following the `recordToolCall → getMetrics → reset` pattern:

1. **ContextWindowTracker** — measures repeated-read ratio as a proxy for context waste
2. **LatencyTracker** — p50/p95/p99 per tool type and per session
3. **TaskCompletionTracker** — task lifecycle ratios (completed vs. abandoned vs. in-progress)
4. **ModelUsageTracker** — which model per request, cost-efficiency per model

---

## Tracker 1: ContextWindowTracker

### File: `packages/nr-ai-mcp-server/src/metrics/context-window-tracker.ts`

This tracker counts how often the same file path is read more than once in a session. A high repeated-read ratio suggests the model is losing context and re-reading rather than retaining information.

#### Interfaces

```typescript
export interface ContextWindowMetrics {
  readonly uniqueFilesRead: number;
  readonly totalReadOperations: number;
  readonly repeatedReadCount: number;
  readonly repeatedReadRatio: number | null; // repeatedReadCount / totalReadOperations
  readonly topRepeatedFiles: ReadonlyArray<{ file: string; readCount: number }>;
  readonly estimatedWasteRatio: number | null; // fraction of reads that were redundant
}
```

#### Class

```typescript
export class ContextWindowTracker {
  private fileReadCounts = new Map<string, number>();

  recordToolCall(record: ToolCallRecord): void {
    // Only track Read operations that have a filePath
    if (record.toolName !== 'Read' || !record.filePath) return;
    const count = this.fileReadCounts.get(record.filePath) ?? 0;
    this.fileReadCounts.set(record.filePath, count + 1);
  }

  getMetrics(): ContextWindowMetrics {
    const entries = [...this.fileReadCounts.entries()];
    const totalReadOperations = entries.reduce((sum, [, c]) => sum + c, 0);
    const uniqueFilesRead = entries.length;
    const repeatedReadCount = entries.reduce(
      (sum, [, c]) => sum + Math.max(0, c - 1),
      0,
    );
    const repeatedReadRatio =
      totalReadOperations > 0 ? repeatedReadCount / totalReadOperations : null;

    const topRepeatedFiles = entries
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, readCount]) => ({ file, readCount }));

    const estimatedWasteRatio = repeatedReadRatio;

    return {
      uniqueFilesRead,
      totalReadOperations,
      repeatedReadCount,
      repeatedReadRatio,
      topRepeatedFiles,
      estimatedWasteRatio,
    };
  }

  reset(_sessionId: string): void {
    this.fileReadCounts.clear();
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_context_efficiency`

Description: `"Get context window efficiency metrics: unique vs. repeated file reads, repeated-read ratio, and top re-read files. A high ratio suggests the model is losing context."`

Handler:

```typescript
export function handleGetContextEfficiency(
  tracker: ContextWindowTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(tracker.getMetrics()) }] };
}
```

#### Tests (`context-window-tracker.test.ts`)

```typescript
describe('ContextWindowTracker', () => {
  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'r1', sessionId: 's1', toolName: 'Read', timestamp: Date.now(),
      durationMs: 10, success: true, platform: 'test',
      filePath: '/src/app.ts',
      ...overrides,
    } as ToolCallRecord;
  }

  it('returns zeros for empty session', () => {
    const t = new ContextWindowTracker();
    const m = t.getMetrics();
    expect(m.totalReadOperations).toBe(0);
    expect(m.repeatedReadRatio).toBeNull();
  });

  it('counts unique reads with no repeats', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/b.ts' }));
    expect(t.getMetrics().uniqueFilesRead).toBe(2);
    expect(t.getMetrics().repeatedReadCount).toBe(0);
  });

  it('counts repeated reads', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    expect(t.getMetrics().repeatedReadCount).toBe(2);
  });

  it('ignores non-Read tool calls', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Bash', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('ignores Read calls without filePath', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('reset clears all state', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord());
    t.reset('new-session');
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('topRepeatedFiles returns up to 5 entries sorted by count', () => {
    const t = new ContextWindowTracker();
    for (let i = 0; i < 6; i++) {
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
    }
    expect(t.getMetrics().topRepeatedFiles).toHaveLength(5);
  });
});
```

---

## Tracker 2: LatencyTracker

### File: `packages/nr-ai-mcp-server/src/metrics/latency-tracker.ts`

Accumulates `durationMs` values per tool name and computes p50/p95/p99 percentiles on demand.

#### Interfaces

```typescript
export interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface LatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles>>;
  readonly slowestCalls: ReadonlyArray<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }>;
}
```

#### Class

```typescript
const MAX_SAMPLES_PER_TOOL = 500;
const MAX_SLOWEST = 10;

export class LatencyTracker {
  private allDurations: number[] = [];
  private byTool = new Map<string, number[]>();
  private slowestCalls: Array<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }> = [];

  recordToolCall(record: ToolCallRecord): void {
    if (record.durationMs === null || record.durationMs === undefined) return;
    const d = record.durationMs;

    // Overall
    this.allDurations.push(d);

    // Per tool
    const key = record.toolName ?? 'Unknown';
    let arr = this.byTool.get(key);
    if (!arr) {
      arr = [];
      this.byTool.set(key, arr);
    }
    if (arr.length < MAX_SAMPLES_PER_TOOL) arr.push(d);

    // Slowest calls
    this.slowestCalls.push({
      toolName: key,
      durationMs: d,
      timestamp: record.timestamp ?? Date.now(),
      ...(record.filePath && { filePath: record.filePath }),
    });
    this.slowestCalls.sort((a, b) => b.durationMs - a.durationMs);
    if (this.slowestCalls.length > MAX_SLOWEST) {
      this.slowestCalls.length = MAX_SLOWEST;
    }
  }

  private computePercentiles(sorted: number[]): LatencyPercentiles {
    const count = sorted.length;
    return {
      p50: sorted[Math.floor(count * 0.5)] ?? 0,
      p95: sorted[Math.floor(count * 0.95)] ?? 0,
      p99: sorted[Math.floor(count * 0.99)] ?? 0,
      min: sorted[0] ?? 0,
      max: sorted[count - 1] ?? 0,
      count,
    };
  }

  getMetrics(): LatencyMetrics {
    const sortedAll = [...this.allDurations].sort((a, b) => a - b);
    const overall = sortedAll.length > 0 ? this.computePercentiles(sortedAll) : null;

    const byTool: Record<string, LatencyPercentiles> = {};
    for (const [tool, durations] of this.byTool) {
      const sorted = [...durations].sort((a, b) => a - b);
      byTool[tool] = this.computePercentiles(sorted);
    }

    return {
      overall,
      byTool,
      slowestCalls: [...this.slowestCalls],
    };
  }

  reset(_sessionId: string): void {
    this.allDurations = [];
    this.byTool.clear();
    this.slowestCalls = [];
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_latency_percentiles`

Description: `"Get p50/p95/p99 latency percentiles for tool calls, broken down by tool type. Use to identify which tools are slowest in the current session."`

#### Tests (`latency-tracker.test.ts`)

Key cases:
- Empty tracker → `overall` is null
- Single call → p50/p95/p99 all equal the single duration
- Multiple calls → p50 is the median
- `reset()` clears everything
- Calls without `durationMs` are ignored
- `slowestCalls` is sorted descending by duration, capped at 10
- Per-tool breakdown uses tool-specific samples

---

## Tracker 3: TaskCompletionTracker

### File: `packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.ts`

Tracks the lifecycle of tasks detected by `TaskDetector`. Receives `AiCodingTask` objects and categorizes them.

#### Background

Read `packages/nr-ai-mcp-server/src/metrics/task-detector.ts` to understand the `AiCodingTask` interface and the `status` field values (`'completed'`, `'in_progress'`).

#### Interfaces

```typescript
export interface TaskCompletionMetrics {
  readonly totalTasksDetected: number;
  readonly completedTasks: number;
  readonly inProgressTasks: number;
  readonly completionRate: number | null; // completed / (completed + inProgress)
  readonly avgTaskDurationMs: number | null;
  readonly avgToolCallsPerTask: number | null;
}
```

#### Class

```typescript
export class TaskCompletionTracker {
  private completed: AiCodingTask[] = [];
  private inProgress: AiCodingTask[] = [];

  recordTask(task: AiCodingTask): void {
    if (task.status === 'completed') {
      this.completed.push(task);
    } else {
      this.inProgress.push(task);
    }
  }

  getMetrics(): TaskCompletionMetrics {
    const totalTasksDetected = this.completed.length + this.inProgress.length;
    const completedCount = this.completed.length;
    const inProgressCount = this.inProgress.length;
    const completionRate =
      totalTasksDetected > 0 ? completedCount / totalTasksDetected : null;

    const completedDurations = this.completed
      .map(t => t.durationMs)
      .filter((d): d is number => d !== null && d !== undefined);
    const avgTaskDurationMs =
      completedDurations.length > 0
        ? completedDurations.reduce((s, d) => s + d, 0) / completedDurations.length
        : null;

    const allToolCounts = [...this.completed, ...this.inProgress].map(
      t => t.toolCalls.length,
    );
    const avgToolCallsPerTask =
      allToolCounts.length > 0
        ? allToolCounts.reduce((s, c) => s + c, 0) / allToolCounts.length
        : null;

    return {
      totalTasksDetected,
      completedTasks: completedCount,
      inProgressTasks: inProgressCount,
      completionRate,
      avgTaskDurationMs,
      avgToolCallsPerTask,
    };
  }

  reset(_sessionId: string): void {
    this.completed = [];
    this.inProgress = [];
  }
}
```

> **Wiring note:** `TaskCompletionTracker.recordTask()` takes an `AiCodingTask`, not a `ToolCallRecord`. In `index.ts`, call it inside the `for (const task of taskDetector.drainNewlyCompletedTasks())` loop and also pass all current in-progress tasks on each `getMetrics()` call. Alternatively, expose a `snapshot()` method on `TaskDetector` to get current in-progress tasks.

#### MCP tool

Tool name: `nr_observe_get_task_completion_rate`

Description: `"Get task lifecycle metrics: completion rate, average task duration, and average tool calls per task. Distinguishes completed tasks from in-progress/abandoned."`

#### Tests (`task-completion-tracker.test.ts`)

Key cases:
- Empty tracker → `completionRate` is null
- All completed → `completionRate === 1`
- Mix of completed and in-progress → correct ratio
- `avgTaskDurationMs` is the mean of completed task durations
- `reset()` clears all state
- Tasks with null durationMs are excluded from avg calculation

---

## Tracker 4: ModelUsageTracker

### File: `packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.ts`

Tracks which model is used per request (from `nr_observe_report_tokens` calls) and computes cost-per-output-token as an efficiency ratio.

#### Background

`CostTracker` already tracks `costByModel`. `ModelUsageTracker` adds request count, token distribution, and efficiency ratios per model.

#### Interfaces

```typescript
export interface ModelStats {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  readonly avgOutputTokensPerRequest: number | null;
}

export interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null; // lowest costPerOutputToken
  readonly totalModelsUsed: number;
}
```

#### Class

```typescript
interface MutableModelStats {
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export class ModelUsageTracker {
  private byModel = new Map<string, MutableModelStats>();

  recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): void {
    let stats = this.byModel.get(model);
    if (!stats) {
      stats = { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
      this.byModel.set(model, stats);
    }
    stats.requestCount++;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCostUsd += costUsd;
  }

  getMetrics(): ModelUsageMetrics {
    const byModel: Record<string, ModelStats> = {};
    let mostUsedModel: string | null = null;
    let maxRequests = 0;
    let mostEfficientModel: string | null = null;
    let lowestCostPerOutputToken = Infinity;

    for (const [model, stats] of this.byModel) {
      const costPerOutputToken =
        stats.totalOutputTokens > 0
          ? stats.totalCostUsd / stats.totalOutputTokens
          : null;
      const avgOutputTokensPerRequest =
        stats.requestCount > 0
          ? stats.totalOutputTokens / stats.requestCount
          : null;

      byModel[model] = {
        requestCount: stats.requestCount,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCostUsd: stats.totalCostUsd,
        costPerOutputToken,
        avgOutputTokensPerRequest,
      };

      if (stats.requestCount > maxRequests) {
        maxRequests = stats.requestCount;
        mostUsedModel = model;
      }

      if (costPerOutputToken !== null && costPerOutputToken < lowestCostPerOutputToken) {
        lowestCostPerOutputToken = costPerOutputToken;
        mostEfficientModel = model;
      }
    }

    return {
      byModel,
      mostUsedModel,
      mostEfficientModel,
      totalModelsUsed: this.byModel.size,
    };
  }

  reset(_sessionId: string): void {
    this.byModel.clear();
  }
}
```

#### Wiring note

`ModelUsageTracker.recordUsage()` is called from the `nr_observe_report_tokens` tool handler (in `cost-tools.ts`), where model, token counts, and cost are already available from `CostTracker.recordTokens()`. Add the call there.

#### MCP tool

Tool name: `nr_observe_get_model_usage`

Description: `"Get per-model usage statistics: request counts, token totals, cost, and cost-per-output-token efficiency ratios. Identifies the most-used and most cost-efficient model."`

#### Tests (`model-usage-tracker.test.ts`)

Key cases:
- Empty tracker → `totalModelsUsed === 0`, `mostUsedModel === null`
- Single model → correct request count and token totals
- Multiple models → `mostUsedModel` is the one with highest requestCount
- `mostEfficientModel` is the one with lowest costPerOutputToken
- `reset()` clears all state
- Model with zero output tokens → `costPerOutputToken` is null (avoid division by zero)

---

## Step — Register all four trackers

### Update `RegisterToolsOptions` in `session-stats.ts`

Add to the options interface:

```typescript
contextWindowTracker?: ContextWindowTracker;
latencyTracker?: LatencyTracker;
taskCompletionTracker?: TaskCompletionTracker;
modelUsageTracker?: ModelUsageTracker;
```

### Add tool definitions and handlers

In the relevant `*-tools.ts` file (or create `packages/nr-ai-mcp-server/src/tools/analytics-tools.ts`), add the four tool definitions and four handler functions following the exact pattern of existing cost/workflow tools.

### Register in `registerTools()`

Add conditional registration (only register if the tracker is provided) for each of the four tools, following the existing pattern:

```typescript
if (options.contextWindowTracker) {
  toolList.push(CONTEXT_EFFICIENCY_TOOL);
}
// ... etc
```

And in the `CallToolRequestSchema` handler add matching cases.

### Instantiate and wire in `index.ts`

```typescript
const contextWindowTracker = new ContextWindowTracker();
const latencyTracker = new LatencyTracker();
const taskCompletionTracker = new TaskCompletionTracker();
const modelUsageTracker = new ModelUsageTracker();
```

In the `onRecord` callback, call `contextWindowTracker.recordToolCall(record)` and `latencyTracker.recordToolCall(record)`.

For `taskCompletionTracker`, call `taskCompletionTracker.recordTask(task)` in the `for (const task of taskDetector.drainNewlyCompletedTasks())` loop.

For `modelUsageTracker`, call `modelUsageTracker.recordUsage(model, inputTokens, outputTokens, costUsd)` from the `nr_observe_report_tokens` handler (pass it down through `registerTools` options).

Pass all four to `registerTools()`.

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all four new test files pass
- [ ] All four trackers implement the `recordToolCall | recordTask | recordUsage → getMetrics → reset` pattern
- [ ] `nr_observe_get_context_efficiency` returns `ContextWindowMetrics` JSON
- [ ] `nr_observe_get_latency_percentiles` returns `LatencyMetrics` JSON
- [ ] `nr_observe_get_task_completion_rate` returns `TaskCompletionMetrics` JSON
- [ ] `nr_observe_get_model_usage` returns `ModelUsageMetrics` JSON
- [ ] `reset()` on each tracker produces the same state as a freshly constructed instance
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/metrics/context-window-tracker.ts
packages/nr-ai-mcp-server/src/metrics/context-window-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/latency-tracker.ts
packages/nr-ai-mcp-server/src/metrics/latency-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.ts
packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.ts
packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.test.ts
packages/nr-ai-mcp-server/src/tools/analytics-tools.ts  (or extend existing)
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/tools/session-stats.ts — add 4 tracker options + registrations
packages/nr-ai-mcp-server/src/tools/cost-tools.ts    — call modelUsageTracker.recordUsage()
packages/nr-ai-mcp-server/src/index.ts               — instantiate + wire all 4 trackers
```
