# Implementation Plan: Session Trace ID

**Roadmap item:** 1 — Session Trace ID
**Effort:** Small (1–2 hours)
**Files to modify:** 3
**Files to create:** 0

---

## Overview

Generate a single UUID at server startup and thread it through every NR event, metric data point, and log entry emitted during that session. After this change every signal in New Relic — tool call events, coding task events, anti-pattern events, metric gauge data points — will carry a `session_id` attribute that can be used in NRQL `WHERE session_id = '...'` queries for per-session deep dives.

**This is a pure additive change.** No existing interfaces are broken; `session_id` is already present on `AiToolCall` events for records that carry a `sessionId` on `ToolCallRecord`. The gap is that:

1. `NrIngestManager` does not store `sessionTraceId` independently — it reads `record.sessionId` from whatever the hook event processor wrote. If that field is absent the attribute is silently dropped.
2. Metric data points (session gauges, cost metrics, efficiency metrics) carry no `session_id` at all.
3. `AiCodingTask` events get `session_id` only if `task.toolCalls[0].sessionId` happens to be set.

The fix: generate one authoritative UUID in `index.ts`, pass it to `NrIngestManager`, and always emit it from there — regardless of whether `record.sessionId` is populated.

---

## Step 1 — Generate `sessionTraceId` in `index.ts`

**File:** `packages/nr-ai-mcp-server/src/index.ts`

Add the import at line 3 (after the `node:` builtins block, before the external packages block):

```typescript
import { randomUUID } from 'node:crypto';
```

Inside the `if (options.stdio)` block, immediately after the `loadMcpConfig(options)` call (around line 137), add:

```typescript
const sessionTraceId = randomUUID();
logger.info('Session trace ID generated', { sessionTraceId });
```

Then pass it to `NrIngestManager` (around line 180–194):

```typescript
nrIngest = new NrIngestManager({
  licenseKey: config.licenseKey,
  transportOptions: {
    accountId: config.accountId,
    collectorHost: config.collectorHost,
  },
  developer: config.developer,
  appName: config.appName,
  sessionTracker,
  localStore,
  eventHarvestIntervalMs: config.harvestIntervalMs.events,
  metricHarvestIntervalMs: config.harvestIntervalMs.metrics,
  costTracker,
  efficiencyScorer,
  sessionTraceId,               // ← ADD THIS LINE
});
```

No change needed for proxy mode — that mode does not use the stdio session lifecycle.

---

## Step 2 — Store and emit `sessionTraceId` in `NrIngestManager`

**File:** `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts`

### 2a — Add `sessionTraceId` to `NrIngestOptions`

In the `NrIngestOptions` interface (around line 46), add one optional field after the existing `sessionId` field:

```typescript
/** Trace ID generated at server startup — threaded through all NR events and metrics. */
sessionTraceId?: string;
```

### 2b — Store `sessionTraceId` on the class

In `NrIngestManager` class body (after the existing `private readonly appName: string;` field, around line 287):

```typescript
private readonly sessionTraceId: string | undefined;
```

In the constructor body (after `this.appName = options.appName;`):

```typescript
this.sessionTraceId = options.sessionTraceId;
```

### 2c — Emit `session_id` on `AiToolCall` events

In `ingestToolCall()` (around line 338), replace the existing `toolCallToNrEvent` call:

```typescript
const event = toolCallToNrEvent(record, {
  developer: this.developer,
  appName: this.appName,
  sessionTraceId: this.sessionTraceId,    // ← ADD THIS
});
```

Update `toolCallToNrEvent()` signature and body (around line 99):

```typescript
export function toolCallToNrEvent(
  record: ToolCallRecord,
  attrs: { developer: string; appName: string; sessionTraceId?: string },
): NrEventData {
  const event: NrEventData = {
    eventType: 'AiToolCall',
    timestamp: Math.floor(record.timestamp / 1000),
    tool: record.toolName,
    tool_use_id: record.toolUseId,
    success: record.success,
    developer: attrs.developer,
    app_name: attrs.appName,
  };

  // Prefer the authoritative trace ID; fall back to per-record sessionId.
  const sessionId = attrs.sessionTraceId ?? record.sessionId;
  if (sessionId != null) event.session_id = sessionId;
  // ... rest unchanged
```

The existing `if (record.sessionId != null) event.session_id = record.sessionId;` line (around line 113) must be **removed** — it is now replaced by the two lines above.

### 2d — Emit `session_id` on `AiCodingTask` events

Update `ingestCodingTask()` (around line 376):

```typescript
ingestCodingTask(task: AiCodingTask): void {
  const event = codingTaskToNrEvent(task, {
    developer: this.developer,
    appName: this.appName,
    sessionTraceId: this.sessionTraceId,    // ← ADD THIS
  });
  this.scheduler.addEvent(event);
}
```

Update `codingTaskToNrEvent()` signature and body (around line 198):

```typescript
export function codingTaskToNrEvent(
  task: AiCodingTask,
  attrs: { developer: string; appName: string; sessionTraceId?: string },
): NrEventData {
  const firstRecord = task.toolCalls[0];
  const platform =
    typeof firstRecord?.platform === 'string' ? firstRecord.platform : 'claude-code';

  const event: NrEventData = {
    // ... (all existing fields unchanged)
  };

  // Prefer the authoritative trace ID; fall back to per-record sessionId.
  const sessionId = attrs.sessionTraceId ?? firstRecord?.sessionId ?? null;
  if (sessionId != null) event.session_id = sessionId;

  return event;
}
```

Remove the original `const sessionId = firstRecord?.sessionId ?? null;` and the later `if (sessionId != null) event.session_id = sessionId;` lines — they are replaced above.

### 2e — Emit `session_id` on `AiAntiPattern` events

Update `ingestAntiPattern()` (around line 384):

```typescript
ingestAntiPattern(
  pattern: AntiPattern,
  context: { sessionId?: string; platform?: string; taskId: string },
): void {
  const event = antiPatternToNrEvent(pattern, {
    developer: this.developer,
    appName: this.appName,
    sessionId: this.sessionTraceId ?? context.sessionId,    // ← CHANGE THIS
    platform: context.platform,
    taskId: context.taskId,
  });
  this.scheduler.addEvent(event);
}
```

No change needed to `antiPatternToNrEvent()` — it already accepts and emits `sessionId` from attrs.

### 2f — Add `session_id` to metric data points in `emitSessionGauges()`

In `emitSessionGauges()` (around line 425), add a helper that wraps `scheduler.recordMetric` to always inject `session_id`:

```typescript
private emitSessionGauges(): void {
  if (!this.running) return;
  const sessionId = this.sessionTraceId;

  // Helper: record a metric, always injecting session_id when available.
  const record = (name: string, value: number, attrs: Record<string, string | number> = {}) => {
    this.scheduler.recordMetric(
      name,
      value,
      sessionId != null ? { session_id: sessionId, ...attrs } : attrs,
    );
  };

  const metrics = this.sessionTracker.getMetrics();
  record('ai.session.duration_ms', metrics.sessionDurationMs);
  record('ai.session.unique_files_read', metrics.uniqueFilesRead);
  record('ai.session.unique_files_written', metrics.uniqueFilesWritten);

  if (this.costTracker || this.efficiencyScorer) {
    const developer = this.developer;
    const scheduler = this.scheduler;
    const devAggregator = {
      record(name: string, value: number, attrs: Record<string, string | number> = {}) {
        scheduler.recordMetric(
          name,
          value,
          sessionId != null
            ? { developer, session_id: sessionId, ...attrs }
            : { developer, ...attrs },
        );
      },
    } as unknown as MetricAggregator;
    this.costTracker?.emitMetrics(devAggregator);
    this.efficiencyScorer?.emitMetrics(devAggregator);
  }

  // Proxy metrics (no session_id — they are cross-session aggregations)
  const proxyMetrics = this.proxyMetrics.getMetrics();
  // ... rest of proxy metrics unchanged
}
```

Also update the two per-call metrics in `ingestToolCall()` to carry `session_id`:

```typescript
ingestToolCall(record: ToolCallRecord): void {
  // ...existing event building...

  const sessionId = this.sessionTraceId;
  const tool = record.toolName;
  this.scheduler.recordMetric(
    'ai.tool.call_count', 1,
    sessionId != null ? { tool, session_id: sessionId } : { tool },
  );
  if (record.durationMs != null) {
    this.scheduler.recordMetric(
      'ai.tool.duration_ms', record.durationMs,
      sessionId != null ? { tool, session_id: sessionId } : { tool },
    );
  }
  this.scheduler.recordMetric(
    'ai.tool.success', record.success ? 1 : 0,
    sessionId != null ? { tool, session_id: sessionId } : { tool },
  );
  // ... rest unchanged
}
```

---

## Step 3 — Expose `sessionTraceId` from `nr_observe_get_session_stats`

**File:** `packages/nr-ai-mcp-server/src/tools/session-stats.ts`

Find the `registerTools` function and the handler for `nr_observe_get_session_stats`. Add `sessionTraceId` as a parameter to `registerTools()` and include it in the tool's response:

### 3a — Update `registerTools` signature

The function currently accepts an options object. Add `sessionTraceId` as an optional field:

```typescript
export function registerTools(
  server: McpServer,
  options: {
    sessionTracker: SessionTracker;
    // ... existing fields ...
    sessionTraceId?: string;        // ← ADD THIS
  },
): void {
```

### 3b — Include `sessionTraceId` in the stats response

In the `nr_observe_get_session_stats` handler, add `session_trace_id` to the returned object:

```typescript
const result = {
  session_trace_id: options.sessionTraceId ?? null,
  // ... existing fields ...
};
```

### 3c — Pass `sessionTraceId` from `index.ts`

In `index.ts`, update the `registerTools` call (around line 239):

```typescript
registerTools(mcpServer.server, {
  sessionTracker,
  costTracker,
  taskDetector,
  antiPatternDetector,
  efficiencyScorer,
  feedbackCollector,
  sessionStore,
  weeklySummaryGenerator,
  trendAnalyzer,
  collaborationProfiler,
  claudeMdTracker,
  costPerOutcomeAnalyzer,
  recommendationEngine,
  sessionTraceId,          // ← ADD THIS LINE
});
```

---

## Step 4 — Tests

**File:** `packages/nr-ai-mcp-server/src/transport/nr-ingest.test.ts`

Add the following test cases to the existing test file. Use the existing `makeRecord`, `makeTask`, `makePattern`, `makeIngestOptions` helpers already defined in the file.

```typescript
// ---------------------------------------------------------------------------
// Session trace ID propagation
// ---------------------------------------------------------------------------

describe('session trace ID propagation', () => {
  const TRACE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('toolCallToNrEvent: uses sessionTraceId when provided, ignoring record.sessionId', () => {
    const record = makeRecord({ sessionId: 'old-session-id' });
    const event = toolCallToNrEvent(record, {
      developer: 'dev',
      appName: 'app',
      sessionTraceId: TRACE_ID,
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('toolCallToNrEvent: falls back to record.sessionId when sessionTraceId is absent', () => {
    const record = makeRecord({ sessionId: 'fallback-id' });
    const event = toolCallToNrEvent(record, { developer: 'dev', appName: 'app' });
    expect(event.session_id).toBe('fallback-id');
  });

  it('toolCallToNrEvent: omits session_id when neither sessionTraceId nor record.sessionId is set', () => {
    const record = makeRecord({ sessionId: undefined });
    const event = toolCallToNrEvent(record, { developer: 'dev', appName: 'app' });
    expect(event.session_id).toBeUndefined();
  });

  it('codingTaskToNrEvent: uses sessionTraceId when provided', () => {
    const task = makeTask();
    const event = codingTaskToNrEvent(task, {
      developer: 'dev',
      appName: 'app',
      sessionTraceId: TRACE_ID,
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('codingTaskToNrEvent: falls back to first toolCall.sessionId when sessionTraceId is absent', () => {
    const task = makeTask({
      toolCalls: [makeRecord({ sessionId: 'record-session-id' })],
    });
    const event = codingTaskToNrEvent(task, { developer: 'dev', appName: 'app' });
    expect(event.session_id).toBe('record-session-id');
  });

  it('antiPatternToNrEvent: emits session_id from attrs.sessionId', () => {
    const pattern = makePattern();
    const event = antiPatternToNrEvent(pattern, {
      developer: 'dev',
      appName: 'app',
      sessionId: TRACE_ID,
      taskId: 'task-1',
    });
    expect(event.session_id).toBe(TRACE_ID);
  });

  it('NrIngestManager.ingestToolCall: emits sessionTraceId as session_id on AiToolCall event', async () => {
    jest.useFakeTimers();
    const capturedEvents: NrEventData[] = [];
    const sendFn = jest.fn<() => Promise<{ success: boolean; statusCode: number; retryCount: number }>>()
      .mockImplementation(async (events) => {
        capturedEvents.push(...(events as NrEventData[]));
        return { success: true, statusCode: 200, retryCount: 0 };
      });

    const manager = new NrIngestManager({
      ...makeIngestOptions({ sendEventsFn: sendFn }),
      sessionTraceId: TRACE_ID,
    });
    manager.start();
    manager.ingestToolCall(makeRecord({ sessionId: 'old-id' }));

    // Advance timer to trigger event harvest
    jest.advanceTimersByTime(200_000);
    await Promise.resolve();

    const toolCallEvent = capturedEvents.find((e) => e.eventType === 'AiToolCall');
    expect(toolCallEvent?.session_id).toBe(TRACE_ID);

    await manager.stop();
    jest.useRealTimers();
  });
});
```

---

## Acceptance Criteria

- [ ] `toolCallToNrEvent()` emits `session_id: sessionTraceId` when `sessionTraceId` is provided, ignoring `record.sessionId`
- [ ] `toolCallToNrEvent()` falls back to `record.sessionId` when `sessionTraceId` is absent (backward compatible)
- [ ] `codingTaskToNrEvent()` emits `session_id: sessionTraceId` when provided
- [ ] `antiPatternToNrEvent()` receives `sessionTraceId` via `ingestAntiPattern()` and emits it as `session_id`
- [ ] `emitSessionGauges()` attaches `session_id` to all session, cost, and efficiency metric data points
- [ ] `ingestToolCall()` attaches `session_id` to `ai.tool.call_count`, `ai.tool.duration_ms`, and `ai.tool.success` metric data points
- [ ] `nr_observe_get_session_stats` response includes `session_trace_id`
- [ ] All 8 new test cases pass
- [ ] `npm run build && npm test && npm run lint` passes with no errors

## Verify with NRQL

After deploying, these queries should return correlated data for a single session:

```sql
-- All tool calls in a session
SELECT * FROM AiToolCall WHERE session_id = '<UUID>' SINCE 1 day ago

-- All tasks in a session
SELECT * FROM AiCodingTask WHERE session_id = '<UUID>' SINCE 1 day ago

-- All anti-patterns in a session
SELECT * FROM AiAntiPattern WHERE session_id = '<UUID>' SINCE 1 day ago

-- All metrics for a session (NR Metrics explorer: filter session_id = '<UUID>')
SELECT average(ai.session.duration_ms) FROM Metric WHERE session_id = '<UUID>' SINCE 1 day ago
```
