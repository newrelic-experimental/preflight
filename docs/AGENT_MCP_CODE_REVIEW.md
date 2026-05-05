# Code Review: nr-ai-mcp-server

**Date:** 2026-04-20
**Scope:** Full source review of `packages/nr-ai-mcp-server/src/`
**Focus:** Real bugs affecting correctness, data integrity, and reliability

---

## Critical / High Severity

### ✅ 1. Data loss in log ingestion on send failure

**File:** `src/transport/log-ingest.ts:121-142`

The `flush()` method clears the buffer (line 124-125) BEFORE attempting to send. If `sendLogsFn()` fails or throws, the logs are permanently dropped with only a warning logged.

```typescript
const batch = this.buffer;
this.buffer = [];          // ← buffer cleared
const result = await this.sendLogsFn(batch, ...); // ← then this fails
// batch is gone forever
```

**Impact:** Security audit trail events and log data can be silently lost on any transient network failure. No retry, no persistent queue.

**Fix:** Re-add the batch to the buffer on failure, or use a persistent queue with retry.

---

### ✅ 2. Data loss in buffer drain on read/unlink failure

**File:** `src/storage/local-store.ts:62-98`

The `drainBuffer()` method renames the buffer file to `.drain` (line 70), then attempts to read and delete it. If `readFileSync()` or `unlinkSync()` fails inside the try block, the catch at line 94 returns `[]`, abandoning the `.drain` file with all its events permanently unprocessed.

**Impact:** Hook events (tool call records) can be lost if a file read error occurs after the rename. The `.drain` file is orphaned on disk with no recovery path.

**Fix:** On failure, rename `.drain` back to the original buffer path, or implement a retry on next poll.

---

### ✅ 3. bashExitCodes map is never populated

**File:** `src/metrics/session-tracker.ts:105, 113-175`

The `bashExitCodes` map is initialized (line 105) and exposed in the stats output (line 200-203), but `recordToolCall()` never writes exit codes to it — even though `ToolCallRecord` has an `exitCode` field.

**Impact:** The `bashExitCodes` field in session stats is always an empty object. Users lose visibility into command success/failure distributions.

**Fix:** Add `if (tool === 'Bash' && record.exitCode != null) { this.bashExitCodes.set(record.exitCode, (this.bashExitCodes.get(record.exitCode) ?? 0) + 1); }` in the Bash tracking block.

---

### ✅ 4. Cross-session tools all advertised regardless of individual dependencies

**File:** `src/tools/session-stats.ts:217-223`

The `hasCrossSession` check uses `||` across all cross-session dependencies. If ANY single dependency exists, ALL 7 cross-session tools are listed. Individual handlers guard with `if (!dep) break;`, so they won't crash — but tools appear available to clients when they actually can't execute.

**Impact:** MCP clients (Claude Code) see tools like `nr_observe_get_cost_per_outcome` listed but get empty/error responses when required dependencies are missing. Confusing UX.

**Fix:** Register each cross-session tool individually based on its specific dependencies.

---

## Medium Severity

### ✅ 5. Anti-pattern: editStreaks.clear() resets ALL files on any verification

**File:** `src/metrics/anti-patterns.ts:247-253`

When a verification command (test/build/lint) is detected, ALL edit streaks across ALL files are cleared. A test targeting File B resets the blind-editing streak for unrelated File A.

**Impact:** False negatives in blind editing detection. Developers editing one file without verification but testing another file will not be flagged.

**Fix:** Track which files are likely being tested (or only reset streaks for files that were recently read/verified), rather than clearing the entire map.

---

### ✅ 6. No timeout on upstream HTTP proxy requests

**File:** `src/proxy/upstream-http.ts:81-189`

The HTTP request to upstream MCP servers has no timeout. A hanging upstream will block the proxy response indefinitely and accumulate stuck connections.

**Impact:** A single slow/unresponsive upstream server can exhaust proxy resources and cause cascading timeouts for all MCP tool calls.

**Fix:** Add a configurable timeout (e.g., 30s default) via `req.setTimeout()` or `AbortController`.

---

### ✅ 7. Incomplete response on upstream error mid-stream

**File:** `src/proxy/upstream-http.ts:136-162`

If the upstream connection errors after some response chunks have arrived, `res.end()` is called (line 154) without the accumulated data. The response size is recorded as 0 (line 158), but some data may have already been implicitly flushed to the client.

**Impact:** Clients may receive truncated responses. Metrics record 0 bytes even though partial data was sent.

**Fix:** Track whether headers/data have already been sent to the client. If mid-stream, destroy the socket to signal error instead of sending a clean `end()`.

---

### ✅ 8. cost_per_outcome handler ignores `since` and `developer` filters

**File:** `src/tools/cross-session-tools.ts:320-323`

The `handleGetCostPerOutcome` handler accepts `since` and `developer` parameters but `taskDetector.getCompletedTasks()` returns ALL tasks unfiltered. The filter parameters are accepted but never applied.

**Impact:** Users cannot filter cost-per-outcome data by time range or developer — they always get all data regardless of what they request.

**Fix:** Filter completed tasks by `since` timestamp and developer before passing to `attributeCosts()`.

---

### ✅ 9. Session gauge timer can fire after scheduler is stopped

**File:** `src/transport/nr-ingest.ts:307-324`

The session gauge interval (with `.unref()`) can fire its callback after `stop()` has been called but before the interval is cleared, attempting to record metrics on a stopped scheduler.

**Impact:** Final session metrics (duration, file counts) at shutdown may be lost silently.

**Fix:** Guard `emitSessionGauges()` with `if (!this.running) return;` at the top.

---

### ✅ 10. Collaboration profile autonomy fallback is inconsistent

**File:** `src/metrics/collaboration-profile.ts:222-225`

When `userMessages === 0`, autonomy returns 0.8 (implying high autonomy). But zero messages means "no data" not "high autonomy." Other fallbacks in the codebase use 0.5 as neutral.

**Impact:** Developers with very few messages (e.g., short sessions, automated runs) get artificially high autonomy scores, skewing team baselines and comparisons.

**Fix:** Return 0.5 (neutral) when insufficient data exists, consistent with other components.

---

## Low Severity

### ✅ 11. proxy-metrics.ts unsafe split with non-null assertion

**File:** `src/metrics/proxy-metrics.ts:197-198, 240-241`

`key.split('|')` is destructured with `!` assertions. If a malformed key contains no `|`, the server name will be `undefined` (cast away by `!`), producing metrics with empty attributes.

**Impact:** Corrupted metric attributes if key format is violated. Unlikely in practice since keys are internally constructed.

---

### ✅ 12. No runtime validation on feedback quality enum

**File:** `src/tools/workflow-tools.ts:290-298`

The `quality` field is typed as `'good' | 'bad' | 'neutral'` but the handler casts with `as unknown as` without runtime validation. Invalid values are stored as-is.

**Impact:** Corrupted feedback data if a client sends non-enum values. Low risk since MCP schema validation usually catches this upstream.

---

## Summary

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | HIGH | log-ingest.ts | Logs dropped on send failure — no retry |
| 2 | HIGH | local-store.ts | Buffer data lost on read error — orphaned .drain file |
| 3 | HIGH | session-tracker.ts | bashExitCodes never populated |
| 4 | HIGH | session-stats.ts | All cross-session tools listed regardless of deps |
| 5 | MEDIUM | anti-patterns.ts | editStreaks.clear() resets all files |
| 6 | MEDIUM | upstream-http.ts | No timeout on proxy requests |
| 7 | MEDIUM | upstream-http.ts | Incomplete response on mid-stream error |
| 8 | MEDIUM | cross-session-tools.ts | cost_per_outcome ignores filter params |
| 9 | MEDIUM | nr-ingest.ts | Timer fires after scheduler stopped |
| 10 | MEDIUM | collaboration-profile.ts | Inconsistent autonomy fallback |
| 11 | LOW | proxy-metrics.ts | Unsafe split with `!` assertion |
| 12 | LOW | workflow-tools.ts | No runtime enum validation |

---

## Recommendation

**Before sharing:** Fix items 1-3 (data loss bugs) — these are the ones that would embarrass in a demo or undermine trust in the tool's data. Item 4 is cosmetic but visible to users.

Items 5-10 are real but unlikely to cause visible issues in a demo context. They should be addressed before any production use.

---

## Implementation Plans

### ✅ Fix #1: Re-queue logs on send failure

**File:** `src/transport/log-ingest.ts`

The buffer swap on line 124-125 is correct for preventing duplicate sends during concurrent flushes — we should keep that pattern. The fix is to re-prepend the batch on failure so the next flush retries them. Add a cap to prevent unbounded growth if the endpoint is permanently down.

Add a class field:

```typescript
private readonly maxBufferSize = 1_000;
```

Replace the `flush()` method body (lines 121-142):

```typescript
async flush(): Promise<void> {
  if (this.buffer.length === 0) return;

  const batch = this.buffer;
  this.buffer = [];

  try {
    const result = await this.sendLogsFn(batch, this.licenseKey, this.transportOptions);
    if (!result.success) {
      logger.warn('Failed to send logs — re-queuing batch for retry', {
        batchSize: batch.length,
        error: result.error,
      });
      this.requeueBatch(batch);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Unexpected error sending logs — re-queuing batch for retry', {
      batchSize: batch.length,
      error: message,
    });
    this.requeueBatch(batch);
  }
}

private requeueBatch(batch: NrLogEntry[]): void {
  // Prepend failed batch so it retries first; cap to prevent unbounded growth
  this.buffer = [...batch, ...this.buffer];
  if (this.buffer.length > this.maxBufferSize) {
    const dropped = this.buffer.length - this.maxBufferSize;
    this.buffer = this.buffer.slice(0, this.maxBufferSize);
    logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
  }
}
```

**Tests to add** (`src/transport/log-ingest.test.ts`):

1. `flush() re-queues batch when sendLogsFn returns failure` — mock sendLogsFn to return `{ success: false }`, call `flush()`, verify buffer still contains the entries, then mock success and flush again to verify retry works.
2. `flush() re-queues batch when sendLogsFn throws` — same pattern with a thrown error.
3. `buffer overflow drops oldest entries` — fill buffer beyond maxBufferSize, verify it caps correctly.

---

### ✅ Fix #2: Recover orphaned .drain file on read failure

**File:** `src/storage/local-store.ts`

The issue is in the inner try/catch block (lines 76-97). If `readFileSync` or `unlinkSync` throws, the `.drain` file is left on disk and never retried. Two changes needed:

**Change A:** At the start of `drainBuffer()`, check for an existing `.drain` file and recover it. This handles both crash recovery and the read-failure case.

Add before the `existsSync(this.bufferPath)` check (line 63):

```typescript
const tmpPath = this.bufferPath + '.drain';

// Recover from a previous failed drain — the .drain file has events that
// were never processed.  Rename it back so it's picked up in this drain.
if (existsSync(tmpPath)) {
  try {
    if (existsSync(this.bufferPath)) {
      // Both files exist (crash during drain while hook was writing).
      // Prepend .drain contents to the buffer so nothing is lost.
      const drainData = readFileSync(tmpPath, 'utf-8');
      const bufferData = readFileSync(this.bufferPath, 'utf-8');
      writeFileSync(this.bufferPath, drainData + bufferData);
      unlinkSync(tmpPath);
    } else {
      renameSync(tmpPath, this.bufferPath);
    }
  } catch {
    logger.warn('Failed to recover .drain file — will retry next poll');
  }
}
```

**Change B:** Remove the now-redundant `const tmpPath` declaration on line 67 (it's declared earlier).

This approach is safe because:
- If only `.drain` exists: simple rename back — same as before, but now we retry.
- If both exist: merge them (`.drain` first since it's older data), then continue the normal drain flow.
- If recovery itself fails: log and try again next poll interval.

**Tests to add** (`src/storage/local-store.test.ts`):

1. `drainBuffer() recovers orphaned .drain file` — create a `.drain` file with valid events, call `drainBuffer()`, verify events are returned.
2. `drainBuffer() merges .drain and buffer when both exist` — create both files, verify all events from both are returned in order.
3. `drainBuffer() handles corrupt .drain file gracefully` — create a `.drain` with invalid data, verify it doesn't crash and skips malformed lines.

---

### ✅ Fix #3: Populate bashExitCodes in session tracker

**File:** `src/metrics/session-tracker.ts`

The Bash tracking block at lines 158-160 only increments `bashCommandsRun`. The `exitCode` field exists on `ToolCallRecord` (it's an index-signature `[key: string]: unknown` property set by the hook parser) and is used elsewhere (e.g., `workflow-tools.ts:172`), but never recorded into the `bashExitCodes` map.

Expand the Bash tracking block (lines 158-160) from:

```typescript
if (tool === 'Bash') {
  this.bashCommandsRun++;
}
```

To:

```typescript
if (tool === 'Bash') {
  this.bashCommandsRun++;
  const exitCode = record.exitCode as number | undefined;
  if (exitCode != null) {
    this.bashExitCodes.set(exitCode, (this.bashExitCodes.get(exitCode) ?? 0) + 1);
  }
}
```

This is safe because:
- `exitCode` comes from the hook parser via the `[key: string]: unknown` index signature, so the cast to `number | undefined` is correct.
- The `!= null` check covers both `undefined` (field not present) and `null` (explicitly null).
- Zero is a valid exit code (success) and will be tracked correctly since `!= null` allows 0 through.

**Tests to add** (`src/metrics/session-tracker.test.ts`):

1. `recordToolCall populates bashExitCodes for Bash commands with exit codes` — record several Bash calls with exit codes 0, 0, 1, 127. Verify `getMetrics().bashExitCodes` is `{ 0: 2, 1: 1, 127: 1 }`.
2. `recordToolCall ignores exit codes for non-Bash tools` — record an Edit call with an `exitCode` field. Verify `bashExitCodes` remains empty.
3. `recordToolCall handles Bash commands without exit codes` — record a Bash call with no `exitCode` field. Verify `bashExitCodes` remains empty and `bashCommandsRun` still increments.

---

### ✅ Fix #4: Register cross-session tools individually based on their specific dependencies

**File:** `src/tools/session-stats.ts`

The current code (lines 217-223) uses a single `||`-chain across all cross-session dependencies and registers all 8 tools if _any_ dependency exists. Each tool's dispatch handler has its own guard (`if (!dep) break;`), so they won't crash — but MCP clients see tools listed that they can't actually execute, producing confusing empty responses.

Replace lines 216-223:

```typescript
// Cross-session tools (registered when their dependencies are available)
const hasCrossSession =
  sessionStore || weeklySummaryGenerator || trendAnalyzer ||
  collaborationProfiler || claudeMdTracker || costPerOutcomeAnalyzer ||
  recommendationEngine;
if (hasCrossSession) {
  tools.push(...CROSS_SESSION_TOOLS);
}
```

With individual registrations:

```typescript
// Cross-session tools — each registered only when its specific dependencies exist
if (sessionStore) {
  tools.push(SESSION_HISTORY_TOOL, PLATFORM_COMPARISON_TOOL);
}
if (weeklySummaryGenerator) {
  tools.push(WEEKLY_SUMMARY_TOOL);
}
if (trendAnalyzer) {
  tools.push(TRENDS_TOOL);
}
if (collaborationProfiler) {
  tools.push(COLLABORATION_PROFILE_TOOL);
}
if (claudeMdTracker) {
  tools.push(CLAUDEMD_IMPACT_TOOL);
}
if (costPerOutcomeAnalyzer && taskDetector) {
  tools.push(COST_PER_OUTCOME_TOOL);
}
if (recommendationEngine) {
  tools.push(RECOMMENDATIONS_TOOL);
}
```

This requires updating the imports from `cross-session-tools.ts`. Currently line 43 imports the grouped array:

```typescript
CROSS_SESSION_TOOLS,
```

Replace with the individual constants:

```typescript
SESSION_HISTORY_TOOL,
WEEKLY_SUMMARY_TOOL,
TRENDS_TOOL,
COLLABORATION_PROFILE_TOOL,
CLAUDEMD_IMPACT_TOOL,
COST_PER_OUTCOME_TOOL,
RECOMMENDATIONS_TOOL,
PLATFORM_COMPARISON_TOOL,
```

The `CROSS_SESSION_TOOLS` array export in `cross-session-tools.ts` can remain for backward compatibility — it's just no longer used in registration.

**Dependency mapping** (derived from each handler's dispatch guard):

| Tool | Required dependency |
|------|-------------------|
| `SESSION_HISTORY_TOOL` | `sessionStore` |
| `WEEKLY_SUMMARY_TOOL` | `weeklySummaryGenerator` |
| `TRENDS_TOOL` | `trendAnalyzer` |
| `COLLABORATION_PROFILE_TOOL` | `collaborationProfiler` |
| `CLAUDEMD_IMPACT_TOOL` | `claudeMdTracker` |
| `COST_PER_OUTCOME_TOOL` | `costPerOutcomeAnalyzer` AND `taskDetector` |
| `RECOMMENDATIONS_TOOL` | `recommendationEngine` |
| `PLATFORM_COMPARISON_TOOL` | `sessionStore` |

**Tests to add** (`src/tools/session-stats.test.ts`):

1. `registerTools with only sessionStore lists only session_history and platform_comparison tools` — create a mock Server, register with only `sessionStore`, verify `ListToolsRequest` returns exactly those 2 cross-session tools.
2. `registerTools with all deps lists all cross-session tools` — register with all dependencies provided, verify all 8 cross-session tools appear.
3. `registerTools with no cross-session deps lists no cross-session tools` — register with only `sessionTracker`, verify no cross-session tool names appear in the list.

---

### ✅ Fix #5: Reset only relevant edit streaks on verification commands

**File:** `src/metrics/anti-patterns.ts`

In `detectBlindEditing()` (line 252), when a verification command (test/build/lint) is detected, `editStreaks.clear()` wipes all per-file streak counters. This means a test targeting File B resets the blind-editing streak for an unrelated File A, producing false negatives.

The challenge: we can't reliably determine which files a test command covers. However, we can improve the heuristic by only resetting streaks for files that were **read** between the last edit and the verification command. If a file was read, it's likely being validated. If it wasn't read, the developer is probably editing it blind.

A simpler and more correct approach: instead of tracking which files tests cover, track the **last read set** and only reset streaks for files in that set.

Replace lines 247-253:

```typescript
} else if (
  call.toolName === 'Bash' &&
  (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
) {
  // Verification command resets all edit streaks
  editStreaks.clear();
}
```

With:

```typescript
} else if (call.toolName === 'Read') {
  // Reading a file counts as partial verification — reset its edit streak
  const file = call.filePath as string | undefined;
  if (file) {
    editStreaks.delete(file);
  }
} else if (
  call.toolName === 'Bash' &&
  (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
) {
  // Verification command (test/build/lint) resets all remaining edit streaks.
  // Files that were read since last edit are already cleared above,
  // but a build/test that passes validates the whole project.
  editStreaks.clear();
}
```

Wait — this still clears all on a test command. The real improvement is to make Read count as verification for individual files, which is the more impactful change. A test/build **does** validate the whole project, so clearing all on those is actually defensible.

However, the original bug report is about tests targeting File B resetting File A. The better fix: only clear streaks for files that the _test output_ mentions, but that's not reliably available. The pragmatic fix is:

Replace the `editStreaks.clear()` block (lines 247-253) with:

```typescript
} else if (call.toolName === 'Read') {
  // Reading a file is a form of verification — reset its streak
  const file = call.filePath as string | undefined;
  if (file) {
    editStreaks.delete(file);
  }
} else if (
  call.toolName === 'Bash' &&
  (call.isTestCommand || call.isBuildCommand || call.isLintCommand)
) {
  // A passing verification command validates all edits
  if (call.success) {
    editStreaks.clear();
  }
  // A failing test/build does NOT clear streaks — the edits still need verification
}
```

This improves detection in two ways:
1. **Read as verification**: reading a file resets its streak, which is the most common "verification" pattern (read file → edit file → read to check).
2. **Failed tests don't clear streaks**: if a test fails, the edits are not validated. Only passing verification resets the counters.

**Tests to add** (`src/metrics/anti-patterns.test.ts`):

1. `blind_editing: Read resets streak for specific file` — Edit A 4 times, Read A, Edit A once more. Should NOT flag A (streak reset by the Read). Edit B 4 times without reading B. Should flag B.
2. `blind_editing: passing test clears all streaks` — Edit A and B 4 times each, then run a passing test. Neither should be flagged.
3. `blind_editing: failing test does NOT clear streaks` — Edit A 4 times, then run a failing test. A should still be flagged.

---

### ✅ Fix #6: Add configurable timeout on upstream HTTP proxy requests

**File:** `src/proxy/upstream-http.ts`

The `forward()` method (lines 81-189) creates an HTTP request with no timeout. A hanging upstream will block indefinitely, accumulating stuck connections. Since MCP tool calls go through this proxy, a single slow upstream can stall the entire tool pipeline.

**Step 1:** Add a `timeoutMs` field to the class. Default to 30 seconds.

Add a class field after line 43:

```typescript
private readonly timeoutMs: number;
```

In the constructor (line 45), read from config with a default:

```typescript
this.timeoutMs = config.timeoutMs ?? 30_000;
```

This requires adding `timeoutMs?: number` to `UpstreamConfig` in `src/proxy/types.ts`.

**Step 2:** Set a timeout on the request in `forward()`. After `upstreamReq` is created (line 84), add a timeout handler:

```typescript
const upstreamReq = requestFn(
  this.url,
  {
    method: req.method ?? 'POST',
    headers,
    timeout: this.timeoutMs,
  },
  (upstreamRes) => {
    // ... existing response handler
  },
);

upstreamReq.on('timeout', () => {
  upstreamReq.destroy(new Error(`Upstream "${this.name}" timed out after ${this.timeoutMs}ms`));
});
```

The `timeout` option on `http.request()` sets the socket timeout. When it fires, we destroy the request which triggers the existing `upstreamReq.on('error', ...)` handler (line 166), which already returns a 502 to the client.

This is safe because:
- The `timeout` option in Node's `http.request` sets `socket.setTimeout()` after the socket is connected. It fires if no data is received within the timeout window.
- Destroying the request triggers the `'error'` event, which is already handled and sends a 502 to the client.
- SSE streams (which are long-lived) will also timeout if the upstream goes silent for too long. This is intentional — a healthy SSE stream sends periodic heartbeat events.

**Tests to add** (`src/proxy/upstream-http.test.ts`):

1. `forward() returns 502 when upstream times out` — create a test HTTP server that never responds, set `timeoutMs: 500`, verify that `forward()` resolves with `statusCode: 502` within ~1s.
2. `default timeout is 30 seconds` — construct HttpUpstream without `timeoutMs`, verify the field defaults to 30000.

---

### ✅ Fix #7: Handle incomplete response on upstream error mid-stream

**File:** `src/proxy/upstream-http.ts`

In the non-SSE response handler (lines 136-162), if the upstream errors after `res.writeHead()` has been called (line 100) and some data chunks have arrived, the error handler calls `res.end()` (line 154) which sends a clean end-of-response signal. The client receives a truncated but syntactically valid HTTP response, which it may try to parse as valid JSON-RPC.

For SSE streams (lines 105-135), the same issue exists: `res.end()` is called on `ByteCountTransform` error, which sends a clean close rather than an error signal.

**Non-SSE fix** (lines 152-161): Instead of calling `res.end()`, destroy the socket to force the client to recognize an error:

Replace:

```typescript
upstreamRes.on('error', (err) => {
  logger.error('Upstream response error', { error: String(err) });
  if (!res.writableEnded) res.end();
  resolve({
    statusCode,
    isStreaming: false,
    responseSizeBytes: 0,
    upstreamLatencyMs,
  });
});
```

With:

```typescript
upstreamRes.on('error', (err) => {
  logger.error('Upstream response error', { error: String(err) });
  const bytesAlreadySent = chunks.reduce((sum, c) => sum + c.length, 0);
  if (bytesAlreadySent > 0 && !res.writableEnded) {
    // Data was already piped — clean end() would produce a truncated response
    // the client might try to parse. Destroy the socket to signal the error.
    res.socket?.destroy();
  } else if (!res.writableEnded) {
    res.end();
  }
  resolve({
    statusCode,
    isStreaming: false,
    responseSizeBytes: bytesAlreadySent,
    upstreamLatencyMs,
  });
});
```

**SSE fix** (lines 109-111): The existing `ByteCountTransform` error handler already calls `res.end()`. Since SSE clients typically reconnect on error anyway, this is less critical, but for consistency:

Replace:

```typescript
counter.on('error', (err) => {
  logger.error('Stream error in ByteCountTransform', { error: String(err) });
  if (!res.writableEnded) res.end();
});
```

With:

```typescript
counter.on('error', (err) => {
  logger.error('Stream error in ByteCountTransform', { error: String(err) });
  if (!res.writableEnded) {
    res.socket?.destroy();
  }
});
```

Also fix the `responseSizeBytes: 0` in the non-SSE error (line 158) — the metric should reflect actual bytes sent, not 0:

The updated code above already passes `bytesAlreadySent` instead of `0`.

**Tests to add** (`src/proxy/upstream-http.test.ts`):

1. `forward() destroys socket when upstream errors after partial data` — create a test server that sends headers + partial body then destroys the connection. Verify the client socket is destroyed (not a clean `end()`).
2. `forward() records actual bytes sent on mid-stream error` — same setup, verify `responseSizeBytes` is non-zero.

---

### ✅ Fix #8: Apply `since` and `developer` filters in cost_per_outcome handler

**File:** `src/tools/cross-session-tools.ts`

The `handleGetCostPerOutcome` handler (lines 363-385) accepts `since` and `developer` parameters but passes all completed tasks from `taskDetector.getCompletedTasks()` directly to `attributeCosts()` without filtering. The parameters are declared in the tool's `inputSchema` (lines 129-136) and parsed from args (lines 319-322), but never applied.

Note: `AiCodingTask` has `startTime` (epoch ms) but no `developer` field. Filtering by developer is not possible at the task level with the current data model. However, filtering by `since` timestamp IS possible.

**Change:** Filter tasks by `since` before passing to `attributeCosts()`:

Replace lines 368-370:

```typescript
const tasks = taskDetector.getCompletedTasks();

const attribution = costPerOutcomeAnalyzer.attributeCosts(tasks);
```

With:

```typescript
let tasks = taskDetector.getCompletedTasks();

// Also include the active task
const current = taskDetector.getCurrentTask();
if (current) {
  tasks = [...tasks, current];
}

// Filter by time range
if (args.since) {
  const sinceMs = new Date(args.since).getTime();
  if (!isNaN(sinceMs)) {
    tasks = tasks.filter((t) => t.startTime >= sinceMs);
  }
}

const attribution = costPerOutcomeAnalyzer.attributeCosts(tasks);
```

For the `developer` parameter: since `AiCodingTask` does not carry a developer field, we should either:
- (a) Remove the `developer` property from the tool's `inputSchema`, or
- (b) Add a `developer` field to `AiCodingTask` for future use.

For now, option (a) is safer — remove the `developer` property from `COST_PER_OUTCOME_TOOL`'s `inputSchema` (lines 133-135 in cross-session-tools.ts) to avoid advertising a filter that can't work:

```typescript
// Remove this from the inputSchema.properties:
developer: {
  type: 'string',
  description: 'Filter by developer name',
},
```

**Tests to add** (`src/tools/cross-session-tools.test.ts`):

1. `handleGetCostPerOutcome filters tasks by since parameter` — create tasks with different timestamps, pass `since` date that excludes older tasks, verify output only reflects recent tasks.
2. `handleGetCostPerOutcome includes active task` — set up a TaskDetector with only an active task (no completed), verify output includes that task's cost data.
3. `handleGetCostPerOutcome handles invalid since date gracefully` — pass `since: "not-a-date"`, verify it returns all tasks rather than crashing.

---

### ✅ Fix #9: Guard session gauge timer against firing after stop

**File:** `src/transport/nr-ingest.ts`

The session gauge interval (lines 307-310) fires on the metric harvest cadence with `.unref()` so it doesn't keep the process alive. However, there's a race: the interval callback can fire between `stop()` being called and `clearInterval()` executing. The `stop()` method at line 313 does clear the interval, but the callback may already be in the event loop queue.

More concretely: `stop()` calls `clearInterval()` (line 316) then `emitSessionGauges()` (line 321) as a final emission. If the timer fires between these two calls (unlikely but possible under event loop pressure), `emitSessionGauges()` runs on a partially stopped scheduler.

**Fix:** Add a `running` flag and guard the callback.

Add a class field:

```typescript
private running = false;
```

In `start()` (line 302), set it:

```typescript
start(): void {
  this.running = true;
  this.scheduler.start();
  this.logIngest.start();
  // ...
}
```

In `stop()` (line 313), clear it first:

```typescript
async stop(): Promise<void> {
  this.running = false;
  // Clear session gauge interval
  if (this.sessionGaugeIntervalId !== null) {
    clearInterval(this.sessionGaugeIntervalId);
    this.sessionGaugeIntervalId = null;
  }
  // ...
}
```

Guard `emitSessionGauges()` (line 326):

```typescript
private emitSessionGauges(): void {
  if (!this.running) return;
  // ... rest unchanged
}
```

Wait — `stop()` calls `emitSessionGauges()` at line 321 as a final emission. With the guard, that final call would be skipped since `running` is already false. Fix: call `emitSessionGauges()` before setting `running = false`, or inline the final emission.

Revised `stop()`:

```typescript
async stop(): Promise<void> {
  // Clear session gauge interval
  if (this.sessionGaugeIntervalId !== null) {
    clearInterval(this.sessionGaugeIntervalId);
    this.sessionGaugeIntervalId = null;
  }

  // Emit final session gauges before marking as stopped
  this.emitSessionGauges();

  this.running = false;

  await Promise.all([this.scheduler.stop(), this.logIngest.stop()]);
}
```

This ensures:
- The guard prevents the interval callback from firing after `running = false`.
- The explicit final emission in `stop()` still runs because `running` is still `true` at that point.
- After `this.running = false`, any queued interval callbacks are no-ops.

**Tests to add** (`src/transport/nr-ingest.test.ts`):

1. `emitSessionGauges is a no-op after stop()` — call `stop()`, then manually invoke `emitSessionGauges()` (via the interval's callback), verify no metrics are recorded to the scheduler.
2. `stop() emits final session gauges before stopping` — spy on `emitSessionGauges`, call `stop()`, verify it was called exactly once during shutdown.

---

### ✅ Fix #10: Use consistent neutral fallback for autonomy when no data exists

**File:** `src/metrics/collaboration-profile.ts`

The `computeAutonomy()` function (lines 222-225) returns `0.8` when `userMessages === 0`, implying high autonomy. But zero messages means "no data," not "the agent was highly autonomous." Other fallback functions in the same file use more appropriate defaults:
- `computeSpecificity()` (line 213): returns `0.5` (neutral) when `userMessages === 0`
- `computeCorrectionRate()` (line 232): returns `1.0` (no corrections) when `userMessages === 0`

The doc comment on line 220 even says "falls back to 0.8 (assumed autonomous)" — the assumption is unjustified.

**Fix:** Change the fallback from `0.8` to `0.5`:

Replace line 223:

```typescript
if (userMessages === 0) return 0.8;
```

With:

```typescript
if (userMessages === 0) return 0.5;
```

Update the doc comment on line 220 from:

```typescript
 * When userMessages is 0, falls back to 0.8 (assumed autonomous).
```

To:

```typescript
 * When userMessages is 0, falls back to 0.5 (neutral — insufficient data).
```

This is safe because:
- 0.5 is the semantic midpoint of the 0-1 range, meaning "unknown."
- It matches the pattern used by `computeSpecificity()`.
- It prevents short/automated sessions from inflating team autonomy baselines.
- The team recommendation engine (line 140 in recommendation-engine.ts) checks `baseline.dimensions.autonomy < 0.5`, so a 0.5 neutral value won't falsely trigger "low team autonomy" recommendations.

**Tests to update** (`src/metrics/collaboration-profile.test.ts`):

1. Update any test asserting autonomy is `0.8` for zero-message sessions to expect `0.5` instead.
2. Add test: `computeProfile returns 0.5 autonomy for sessions with zero user messages` — save a session with `userMessages: 0`, compute profile, verify `dimensions.autonomy === 0.5`.

---

### ✅ Fix #11: Safe destructuring of pipe-delimited metric keys

**File:** `src/metrics/proxy-metrics.ts`

Lines 197-198 and 240-241 destructure `key.split('|')` with non-null assertions (`!`):

```typescript
const [tool, server] = key.split('|');
toolPopularity.push({ tool: tool!, server: server!, count });
```

If a malformed key somehow lacks a `|`, `server` is `undefined` (cast away by `!`), producing metric attributes with `undefined` values. While keys are internally constructed and should always contain `|`, defensive code is cheap here.

**Fix:** Add a fallback for both destructured values. Replace both occurrences (lines 197-198 and 240-241):

At line 197-198:

```typescript
const [tool = 'unknown', server = 'unknown'] = key.split('|');
toolPopularity.push({ tool, server, count });
```

At line 240-241:

```typescript
const [tool = 'unknown', server = 'unknown'] = key.split('|');
aggregator.record('ai.mcp.tool_popularity', count, { tool, server });
```

This removes the need for `!` assertions and produces valid (if unexpected) attributes instead of `undefined`. No new tests needed — this is a defensive coding improvement against a practically impossible scenario.

---

### ✅ Fix #12: Add runtime validation for feedback quality enum

**File:** `src/tools/workflow-tools.ts`

The `handleReportFeedback` function (lines 290-298) accepts a `quality` field typed as `'good' | 'bad' | 'neutral'` but performs no runtime validation. MCP schema validation _usually_ catches invalid values, but if a client bypasses schema validation or the schema is misconfigured, invalid values are stored as-is into the feedback record.

**Fix:** Add a runtime check at the top of the handler:

Replace lines 290-298:

```typescript
export function handleReportFeedback(
  feedbackCollector: FeedbackCollector,
  args: { quality: 'good' | 'bad' | 'neutral'; notes?: string; task_id?: string },
) {
  const record = feedbackCollector.record({
    quality: args.quality,
    notes: args.notes,
    taskId: args.task_id,
  });
```

With:

```typescript
const VALID_QUALITY_VALUES = new Set(['good', 'bad', 'neutral']);

export function handleReportFeedback(
  feedbackCollector: FeedbackCollector,
  args: { quality: 'good' | 'bad' | 'neutral'; notes?: string; task_id?: string },
) {
  if (!VALID_QUALITY_VALUES.has(args.quality)) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: `Invalid quality value: "${args.quality}". Must be one of: good, bad, neutral`,
        }),
      }],
      isError: true,
    };
  }

  const record = feedbackCollector.record({
    quality: args.quality,
    notes: args.notes,
    taskId: args.task_id,
  });
```

This is a lightweight guard that:
- Returns a clear error message with `isError: true` so MCP clients can distinguish it from success.
- Prevents invalid data from reaching the feedback store.
- Has zero cost for valid inputs (a Set lookup).

**Tests to add** (`src/tools/workflow-tools.test.ts`):

1. `handleReportFeedback rejects invalid quality values` — call with `quality: 'excellent'`, verify `isError: true` in response.
2. `handleReportFeedback accepts all valid quality values` — call with each of `'good'`, `'bad'`, `'neutral'`, verify each returns `recorded: true`.

---
---

# Code Review — Round 2

**Date:** 2026-04-21
**Scope:** Full source review of `packages/nr-ai-mcp-server/src/` and `packages/shared/src/`
**Method:** 6-agent parallel review covering metrics, transport/proxy, tools/server, shared package, platforms/storage/hooks, and cross-cutting concerns
**Focus:** Real bugs affecting correctness, data integrity, and reliability — not already found in Round 1

---

## Summary

| # | Severity | File | Issue |
|---|----------|------|-------|
| 13 | HIGH | shared/harvest-scheduler.ts | Events and metrics dropped on send failure — no re-queue |
| 14 | HIGH | upstream-http.ts | SSE upstream connection leaks when client disconnects |
| ✅ 15 | MEDIUM | collaboration-profile.ts | `autonomy` and `correctionRate` use identical formula — `Collaborative` classification unreachable |
| ✅ 16 | MEDIUM | cost-tracker.ts | `reportCount` double-counts estimations |
| ✅ 17 | MEDIUM | claudemd-tracker.ts | `contextTokensForClaudeMd` uses lines-added-in-edit instead of total file size |
| ✅ 18 | MEDIUM | anti-patterns.ts | `flagged` map cleared/deleted too aggressively — already-detected patterns lost |
| ✅ 19 | MEDIUM | shared/metric-aggregator.ts | `.count` and `.sum` metrics emitted as `gauge` instead of `count` type |
| ✅ 20 | MEDIUM | cross-session-tools.ts | Invalid `since` date throws unhandled `RangeError` |
| ✅ 21 | MEDIUM | cost-tools.ts | `by_model` attributes ALL session costs to the last-used model |
| ✅ 22 | MEDIUM | workflow-tools.ts | Active task efficiency score permanently stale after first query |
| ✅ 23 | MEDIUM | tool-parsers.ts | `output` parameter ignored — Bash `exitCode` never extracted (makes Round 1 fix #3 a no-op) |
| ✅ 24 | MEDIUM | config.ts / index.ts | `config.enabled` is read but never checked — disable toggle non-functional |
| ✅ 25 | MEDIUM | index.ts | Concurrent shutdown calls can cause incomplete final event flush |
| ✅ 26 | MEDIUM | upstream-stdio.ts | Default case in `dispatchToClient` always fails with TypeError |
| ✅ 27 | MEDIUM | proxy-manager.ts | `start()` hangs forever and crashes on port conflict |
| ✅ 28 | MEDIUM | session-store.ts | `buildSessionSummary` drops the active task's data |
| 29 | ✅ MEDIUM | audit-trail.ts | `/token/i` and `/password/i` regex match common source files — false positive alerts |
| 30 | ✅ LOW | shared/metric-aggregator.ts | `sumOfSquares` tracked but never emitted |
| 31 | ✅ LOW | shared/harvest-scheduler.ts | Scheduler's own SIGTERM handler races with main shutdown |
| 32 | ✅ LOW | event-processor.ts | `durationMs` can be negative on clock adjustment |

---

## Critical / High Severity

### ✅ 13. Data loss in HarvestScheduler on send failure (shared package)

**File:** `packages/shared/src/harvest/harvest-scheduler.ts:127-167`

The `harvestEvents()` method calls `this.eventBuffer.flush()` which atomically drains the buffer and returns the batch. If `sendEventsFn()` then fails (returns `{ success: false }` or throws), the batch is logged as "dropped" and permanently lost. The identical pattern exists in `harvestMetrics()` with `this.metricAggregator.harvest()`.

This is the same data-loss pattern as Round 1 bug #1, which was found and fixed in `packages/nr-ai-mcp-server/src/transport/log-ingest.ts`. The shared `HarvestScheduler` was **not** fixed — it has the identical vulnerability.

```typescript
const batch = this.eventBuffer.flush();  // ← buffer drained
const result = await this.sendEventsFn(batch, ...);
if (!result.success) {
  logger.warn('Failed to send events — batch dropped', { droppedCount: batch.length });
  // batch is gone forever
}
```

**Impact:** On any transient network failure or NR API outage, an entire harvest cycle's worth of `AiToolCall` events AND metric data are silently dropped. The `sendWithRetry` in `http-client.ts` does retry on 408/429/5xx, but if all retries fail, the batch is permanently lost. This is the primary data pipeline — all events and metrics flow through this class.

**Fix:** Same approach as the Round 1 log-ingest fix — re-queue the batch on failure with a cap to prevent unbounded growth. Apply to both `harvestEvents()` and `harvestMetrics()`.

---

### ✅ 14. SSE upstream connection leaks when client disconnects

**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:108-140`

In the SSE streaming path, `upstreamRes.pipe(counter).pipe(res)` sets up a pipe chain. There is no handler for client disconnection (`res.on('close', ...)` is never registered). When the client closes the connection:

1. `res` becomes a destroyed writable stream
2. `counter` tries to write to the destroyed `res`, gets an error
3. The `counter.on('error')` handler fires and destroys `res.socket` (already destroyed)
4. But `upstreamRes` (the upstream HTTP connection) is never destroyed or unpiped
5. The `forward()` promise waits for `upstreamRes.on('end')` or `upstreamRes.on('error')`, neither of which fires because the upstream is still sending data

The `forward()` promise never resolves, and the upstream connection stays open until the upstream server closes it (which for SSE could be hours or never).

**Impact:** Each client disconnect during SSE streaming leaks one upstream HTTP connection. Over time, this accumulates open sockets and unresolved promises. For long-running proxy instances, this leads to resource exhaustion.

**Fix:** Add a `res.on('close', ...)` handler that destroys the upstream connection and resolves the promise:

```typescript
res.on('close', () => {
  if (!upstreamRes.destroyed) {
    upstreamRes.destroy();
  }
  resolve({
    statusCode,
    isStreaming: true,
    responseSizeBytes: counter.bytes,
    upstreamLatencyMs,
  });
});
```

---

## Medium Severity

### ✅ 15. `autonomy` and `correctionRate` use identical formula — `Collaborative` classification unreachable

**File:** `src/metrics/collaboration-profile.ts:222-234, 265-272`

`computeAutonomy(corrections, userMessages)` computes `1 - corrections / userMessages`. `computeCorrectionRate(corrections, userMessages)` computes `1 - corrections / userMessages`. Both receive the same inputs (`totalUserCorrections, totalUserMessages`) from `computeDimensions` at lines 202-203. Therefore `autonomy === correctionRate` always when `userMessages > 0`.

In `classify()` (line 265-272):
- Case 2 (`Delegator`): `specificity < 0.6 && autonomy >= 0.6`
- Case 3 (`Learning`): `specificity < 0.6 && correctionRate < 0.6`
- Case 4 (`Collaborative`): default/else

Since `autonomy === correctionRate`, once case 2 fails (autonomy < 0.6), case 3's `correctionRate < 0.6` is always true. The `Collaborative` classification is unreachable.

**Impact:** Developers who should be classified as `Collaborative` are classified as `Learning`. This affects the collaboration profile output and NR events. The `autonomy` dimension was likely intended to measure something different from correction rate (e.g., ratio of questions asked to tool calls).

**Fix:** Redesign `computeAutonomy` to measure a distinct dimension — e.g., based on `askedUserQuestions / toolCalls` (as done in `efficiency-score.ts:194-197`) rather than the correction ratio.

---

### ✅ 16. `reportCount` double-counts estimations in CostTracker

**File:** `src/metrics/cost-tracker.ts:81-93`

`recordEstimatedTokens()` increments `this.estimationCount` (line 91), then delegates to `this.recordTokenUsage()` (line 92), which increments `this.reportCount` (line 71). After N estimation calls: `reportCount = N` and `estimationCount = N`, suggesting N direct reports AND N estimations (2N total) when there were only N estimations.

**Impact:** The `reportCount` and `estimationCount` fields in cost metrics (exposed via `nr_observe_get_cost_breakdown`) are misleading. The `ai.cost.report_count` metric emitted to NR is inflated.

**Fix:** Don't increment `reportCount` in `recordTokenUsage` when called from `recordEstimatedTokens`, or change `reportCount` to mean "total reports including estimations" and document it accordingly.

---

### ✅ 17. `contextTokensForClaudeMd` severely underestimates token count for modifications

**File:** `src/metrics/claudemd-tracker.ts:232-239`

The context token estimate uses `latestChange.linesAdded * 40 * TOKENS_PER_CHAR` (i.e., `linesAdded * 10`). The `linesAdded` value represents lines added in that specific edit, not the total file size. For a modification that adds 3 lines to a 500-line CLAUDE.md, this estimates ~30 tokens when the actual context cost is the entire file (~5000 tokens).

The class already has a correct `estimateContextCost()` static method (line 262-276) that reads the actual file and computes tokens from total character count, but `computeImpact()` doesn't use it.

**Impact:** The `contextTokensForClaudeMd` field is wildly inaccurate (1-2 orders of magnitude low). The recommendation engine's "Large CLAUDE.md context cost" recommendation (3000-token threshold in `recommendation-engine.ts:291-299`) almost never triggers.

**Fix:** Use `estimateContextCost()` or read the file's total size instead of `linesAdded`.

---

### ✅ 18. `flagged` map cleared/deleted too aggressively in blind editing detection

**File:** `src/metrics/anti-patterns.ts:250-259`

Two related bugs in `detectBlindEditing()`:

**Bug A (line 251):** When a `Read` is detected for a file, `flagged.delete(file)` removes an already-confirmed detection. If file A was edited 5+ times (exceeding threshold, added to `flagged`), then a Read of file A occurs later, the confirmed pattern is erased. Only `editStreaks.delete(file)` (resetting the streak counter) is correct here.

**Bug B (line 259):** When a successful verification command runs, `flagged.clear()` wipes ALL already-detected patterns. Consider: Edit A 5 times (flagged), Edit B 5 times (flagged), then run a passing test — both detections are lost, function returns zero patterns.

The `flagged` map should accumulate final results and never be cleared. Only `editStreaks` should be reset.

**Impact:** False negatives in blind editing detection. Anti-pattern counts are understated, giving users an overly optimistic view of editing habits.

**Fix:** Remove `flagged.delete(file)` on Read (line 251) and `flagged.clear()` on verification (line 259). Only clear/delete from `editStreaks`.

---

### ✅ 19. `.count` and `.sum` metrics emitted as `gauge` type instead of `count`

**File:** `packages/shared/src/harvest/metric-aggregator.ts:59-70`

The `harvest()` method emits all sub-metrics (`.count`, `.sum`, `.min`, `.max`) with `type: 'gauge'`. The `.count` and `.sum` sub-metrics are cumulative within an aggregation interval and should be `type: 'count'` for correct interpretation by the NR Metric API. Gauges represent point-in-time values — NR will average/latest them instead of summing across intervals.

**Impact:** NRQL queries like `FROM Metric SELECT sum(ai.request.duration.count)` over time windows will not aggregate correctly. Rate calculations (`rate(sum(...), 1 minute)`) also produce incorrect results. The `.min` and `.max` sub-metrics ARE correctly typed as gauges.

**Fix:** Use `type: 'count'` for the `.count` and `.sum` metrics:

```typescript
metrics.push({ ...base, type: 'count', name: `${bucket.name}.count`, value: bucket.count });
metrics.push({ ...base, type: 'count', name: `${bucket.name}.sum`, value: bucket.sum });
metrics.push({ ...base, name: `${bucket.name}.min`, value: bucket.min });
metrics.push({ ...base, name: `${bucket.name}.max`, value: bucket.max });
```

---

### ✅ 20. Invalid `since` date throws unhandled `RangeError` in session history

**File:** `src/tools/cross-session-tools.ts:201`

`handleGetSessionHistory` creates a `Date` from the user-provided `since` string without validation. `new Date("not-a-date")` produces an Invalid Date, which propagates to `sessionStore.loadAllSessions()` → `formatDate()` → `date.toISOString()`, which throws `RangeError: Invalid time value`.

Note: `handleGetCostPerOutcome` (line 372) correctly handles this case with `isNaN(sinceMs)` — this handler was missed.

**Impact:** Confusing opaque error message instead of a clear "invalid date" response. Does not crash the server (MCP SDK catches it).

**Fix:** Validate the date before use:

```typescript
const since = args.since ? new Date(args.since) : undefined;
if (since && isNaN(since.getTime())) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid since date' }) }], isError: true };
}
```

---

### ✅ 21. `by_model` cost breakdown attributes ALL session costs to the last-used model

**File:** `src/tools/cost-tools.ts:118-121`

`handleGetCostBreakdown` builds a `byModel` object by assigning the **entire** `sessionTotalCostUsd` to `metrics.model` (the most recently used model). If a user switches models during a session (e.g., Sonnet for some work, Opus for other work), `by_model` will have a single entry attributing all costs to the last model.

```typescript
const byModel: Record<string, number> = {};
if (metrics.model && metrics.sessionTotalCostUsd !== null) {
  byModel[metrics.model] = metrics.sessionTotalCostUsd;  // ← all costs to last model
}
```

**Impact:** Wrong cost attribution data. Users comparing model costs get incorrect numbers. The `total_usd` field is correct; only the `by_model` breakdown is wrong.

**Fix:** Track per-model cost accumulation in `CostTracker` (e.g., a `Map<string, number>` incremented in `recordTokenUsage`), and expose it in `getMetrics()`.

---

### ✅ 22. Active task efficiency score permanently stale after first query

**File:** `src/tools/workflow-tools.ts:249-260`

`handleGetEfficiencyScore` scores unscored tasks by checking `scoredIds.has(task.taskId)`. The first time this tool is called while a task is active, the active task gets scored and its `taskId` added to `scoredIds`. On subsequent calls, the same `taskId` is already in `scoredIds` — it's skipped even though the task now has more tool calls and different metrics.

**Impact:** If a user calls `nr_observe_get_efficiency_score` early in a task (e.g., after 5 tool calls), the score is locked in. Calling it again after 50 more tool calls returns the same stale score. The `session_average` is also affected.

**Fix:** For active tasks, always recompute the score (replace the stale entry). Only use `scoredIds` caching for completed/immutable tasks.

---

### ✅ 23. `parseToolSpecificFields` ignores `output` parameter — Bash `exitCode` never extracted

**File:** `src/hooks/tool-parsers.ts:154-172`

`parseToolSpecificFields(toolName, input, output)` accepts an `output` parameter but never uses it. The function body only runs `INPUT_PARSERS[toolName]` — there are no output parsers. For Bash commands, the `tool_response` from Claude Code's hook contains the exit code, but since the output is never parsed, the `exitCode` field is never set on `ToolCallRecord`.

**Impact:** This makes the Round 1 fix #3 (populate `bashExitCodes` in `session-tracker.ts`) a **no-op** — the reading code is there but no data ever arrives through the hook pipeline. The `bashExitCodes` map remains empty in production. The workflow trace also never shows exit codes.

**Fix:** Add an `OUTPUT_PARSERS` map with a Bash output parser that extracts `exitCode` from the tool response:

```typescript
const OUTPUT_PARSERS: Record<string, (output: Record<string, unknown>) => ToolFields> = {
  Bash: (output) => {
    const fields: ToolFields = {};
    if (typeof output.exitCode === 'number') {
      fields.exitCode = output.exitCode;
    }
    return fields;
  },
};
```

And call it in `parseToolSpecificFields`:

```typescript
const outputParser = OUTPUT_PARSERS[toolName];
if (outputParser && output !== null && output !== undefined && typeof output === 'object') {
  Object.assign(fields, outputParser(output as Record<string, unknown>));
}
```

---

### ✅ 24. `config.enabled` is read but never checked — disable toggle non-functional

**Files:** `src/config.ts:152-153`, `src/index.ts`

`config.enabled` is loaded from the `NEW_RELIC_AI_MCP_ENABLED` env var (line 153) and stored in the frozen config object. It's even logged in debug output. But no code path in `index.ts` or anywhere else ever checks `config.enabled`. The server starts, registers hooks, ingests events, and sends data to NR regardless.

**Impact:** Users who set `NEW_RELIC_AI_MCP_ENABLED=false` expecting to disable the server find it running normally. The documented configuration option is non-functional.

**Fix:** Add an early exit in `main()` in `index.ts`:

```typescript
if (!config.enabled) {
  logger.info('Server disabled via config — exiting');
  process.exit(0);
}
```

---

### ✅ 25. Concurrent shutdown calls can cause incomplete final event flush

**File:** `src/index.ts:182-196`

The `shutdown` function is registered with `process.on('SIGINT', shutdown)`, `process.on('SIGTERM', shutdown)`, AND `process.stdin.on('end', ...)`. All three use `process.on` (not `once`), so:

1. The same signal can trigger `shutdown` twice (SIGINT sent twice rapidly)
2. `stdin` closing and a signal can arrive simultaneously (common when the parent process dies)
3. The `stdin.on('end')` callback calls `shutdown()` without `await`, so the promise floats

When two concurrent `shutdown()` calls race, both call `await nrIngest.stop()` then `process.exit(0)`. The first call to reach `process.exit(0)` kills the process before the other call's final flush completes.

**Impact:** The final event batch and metric harvest may be dropped on shutdown. The window is small but the scenario (stdin close + SIGTERM) is common when Claude Code terminates.

**Fix:** Add a guard:

```typescript
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // ... rest of shutdown
};
```

---

### ✅ 26. Default case in `dispatchToClient` always fails with TypeError

**File:** `src/proxy/upstream-stdio.ts:209-214`

The `default` case calls `client.request()` with `{} as Parameters<typeof client.request>[1]` as the result schema. At runtime, the MCP SDK calls `safeParse({}, response.result)`, which tries `{}.safeParse(data)` — since a plain object has no `safeParse` method, this throws `TypeError: v3Schema.safeParse is not a function`.

```typescript
default:
  return client.request(
    { method: rpc.method, params } as Parameters<typeof client.request>[0],
    {} as Parameters<typeof client.request>[1],  // ← always throws TypeError
  );
```

**Impact:** Any MCP method not explicitly handled (e.g., `prompts/list`, `prompts/get`, `completions/complete`, or custom methods) always fails with an opaque error, even if the upstream processes the request successfully. Breaks the proxy's transparent passthrough contract.

**Fix:** Use `z.any()` from Zod as the result schema for unknown methods:

```typescript
import { z } from 'zod';
// ...
default:
  return client.request(
    { method: rpc.method, params } as Parameters<typeof client.request>[0],
    z.any(),
  );
```

---

### ✅ 27. `ProxyManager.start()` hangs forever and crashes on port conflict

**File:** `src/proxy/proxy-manager.ts:120-125`

`start()` wraps `server.listen()` in a `new Promise((resolve) => { ... })` with no `reject` call and no `'error'` event handler on the HTTP server. When `listen()` fails (e.g., `EADDRINUSE`):

1. The callback is never invoked → `resolve()` never called → promise hangs forever
2. The server emits an unhandled `'error'` event → Node.js throws an uncaught exception → process crashes

```typescript
return new Promise((resolve) => {
  this.httpServer!.listen(this.port, '127.0.0.1', () => {
    resolve();   // ← only called on success
  });
  // ← no error handler
});
```

**Impact:** Process crash on port conflict. Easy to trigger when running multiple instances during development.

**Fix:** Add an error handler that rejects the promise:

```typescript
return new Promise<void>((resolve, reject) => {
  this.httpServer!.once('error', reject);
  this.httpServer!.listen(this.port, '127.0.0.1', () => {
    resolve();
  });
});
```

---

### ✅ 28. `buildSessionSummary` drops the active task's data

**File:** `src/storage/session-store.ts:220-232`

`buildSessionSummary` iterates only `taskMetrics.completedTasks` (line 221) and does not include the currently active task. When a session ends, the last task is typically still active (it hasn't been auto-completed). The active task's files, lines changed, tests run, builds run, and tool calls are all excluded from the summary.

**Impact:** Session summaries systematically undercount metrics for the final task. For short sessions with only one task, the summary shows zero files, zero lines changed, zero tests. This affects weekly summaries, cross-session analytics, and the session history tool.

**Fix:** Include the active task when building the summary:

```typescript
const allTasks = [...taskMetrics.completedTasks];
const activeTasks = taskMetrics.activeTasks ?? [];
allTasks.push(...activeTasks);
for (const task of allTasks) { ... }
```

---

### ✅ 29. `/token/i` and `/password/i` regex match common source files — false positive alerts

**File:** `src/security/audit-trail.ts:67, 70`

`DEFAULT_SENSITIVE_FILE_PATTERNS` includes `/password/i` (line 67) and `/token/i` (line 70) as bare substring matches without path-boundary anchors. These match any file path containing "password" or "token" anywhere: `src/utils/tokenizer.ts`, `src/auth/PasswordReset.tsx`, `src/services/token-refresh.ts`, etc.

**Impact:** Every Read/Write/Edit of files with "token" or "password" in the path generates a `high` severity security alert. These pollute logs, inflate `securityAlerts` counts, and emit false `SecurityAlert` NR events.

**Fix:** Add path-boundary anchors so these only match files likely to contain credentials:

```typescript
/(?:^|\/)password(?:s)?(?:\.[^/]*)?$/i,  // matches "password.txt", "passwords.json"
/(?:^|\/)token(?:s)?(?:\.[^/]*)?$/i,     // matches "token.json", "tokens.yaml"
```

---

## Low Severity

### ✅ 30. `sumOfSquares` tracked in MetricAggregator but never emitted

**File:** `packages/shared/src/harvest/metric-aggregator.ts:49, 59-70`

`record()` accumulates `sumOfSquares` (line 49: `bucket.sumOfSquares += value * value`) but `harvest()` never includes it in the output metrics. The `MetricAccumulator` interface exports `sumOfSquares` as a public field, advertising a capability that doesn't reach NR.

**Impact:** Wasted computation on every `record()` call. Any consumer expecting variance/stddev data from NR will find it missing. No current consumer appears to use it.

**Fix:** Either emit it as an additional metric in `harvest()`, or remove the computation and the field from the interface to avoid confusion.

---

### ✅ 31. HarvestScheduler's own SIGTERM handler races with main shutdown

**Files:** `packages/shared/src/harvest/harvest-scheduler.ts:62-67, 96-97`, `src/index.ts:182-196`

The `HarvestScheduler` constructor creates a `boundSigterm` handler that calls `void this.stop()` (fire-and-forget). It registers this with `process.once('SIGTERM', ...)` at `start()`. Meanwhile, `index.ts` registers its own SIGTERM handler that calls `await nrIngest.stop()` → `await this.scheduler.stop()`.

On SIGTERM:
1. The scheduler's handler fires first and calls `void this.stop()` — sets `this.running = false`
2. The `index.ts` handler calls `await scheduler.stop()` — sees `!this.running` and returns immediately, skipping final flush
3. The first call's fire-and-forget stop may still be in-progress, but `index.ts` proceeds to `process.exit(0)`

**Impact:** Only affects SIGTERM path. The scheduler's handler steals the `running` flag, causing the main shutdown's awaited `stop()` to short-circuit. Final harvest may not complete.

**Fix:** Remove the scheduler's own SIGTERM handler (let the parent manage lifecycle), or make `stop()` idempotent by awaiting the first call's completion.

---

### ✅ 32. `durationMs` can be negative when system clock adjusts between hook invocations

**File:** `src/hooks/event-processor.ts:176`

Duration is computed as `event.timestamp - preEvent.timestamp`. Both timestamps come from `Date.now()` in separate process invocations (pre-hook and post-hook). If a system clock adjustment (NTP sync, DST, manual change) occurs between them, the post timestamp could be earlier, producing a negative `durationMs`.

**Impact:** Negative durations propagate to NR metrics (`ai.tool.duration_ms`), efficiency score calculations, session stats averages, and anti-pattern detection. Rare in practice but corrupts metrics widely when it occurs.

**Fix:** `Math.max(0, event.timestamp - preEvent.timestamp)`.

---

## Round 2 Recommendation

**Before sharing (blockers):**
- **#13** (HarvestScheduler data loss) — same class as Round 1 bug #1 but in the primary data pipeline. Every transient network failure drops an entire harvest batch of events and metrics.
- **#23** (output parser missing) — makes the Round 1 fix #3 a no-op. `bashExitCodes` will always be empty.
- **#14** (SSE connection leak) — only applies to proxy mode, but is unbounded resource growth.

**Before production use:**
- **#15** (identical formula), **#16** (double-count), **#17** (token underestimate), **#18** (false negatives), **#21** (wrong by_model), **#22** (stale score) — all produce incorrect data shown to users.
- **#24** (enabled toggle), **#25** (shutdown race), **#26** (stdio default case), **#27** (port crash) — operational issues.
- **#19** (metric type) — affects all NR metric queries using `sum()` or `rate()`.

**Low priority:** #28-32 are real but unlikely to cause visible issues in a demo.

---
---

# Code Review — Round 3

**Date:** 2026-04-21
**Scope:** Final deep review of `packages/nr-ai-mcp-server/src/` and `packages/shared/src/`
**Method:** 5-agent parallel review covering hooks/events, metrics trackers, tools/transport/storage, shared package, and entry points/platforms
**Focus:** Real bugs not already found in Rounds 1 or 2

---

## Summary

| # | Severity | Package | File | Issue |
|---|----------|---------|------|-------|
| 33 | CRITICAL | shared | harvest-scheduler.ts | `stopPromise` never cleared — restart+stop cycle skips final flush |
| 34 | CRITICAL | shared | pricing-data.ts | Pricing table missing current model names — $0 costs for newer models |
| 35 | HIGH | shared | tokens.ts | `totalTokens` excludes cache tokens — undercounts by 10-90% |
| 36 | HIGH | shared | harvest-scheduler.ts | Retry buffers drop newest events on overflow, keep oldest — log says opposite |
| 37 | HIGH | mcp-server | collector-script.ts | Raw tool input/output written to disk regardless of `recordContent` setting |
| 38 | HIGH | mcp-server | session-store.ts | `linesRemoved` hardcoded to 0 in session summaries |
| 39 | HIGH | mcp-server | proxy-manager.ts | Silent upstream connection failures — proxy starts with no working upstreams |
| 40 | MEDIUM | shared | http-client.ts | HTTP success range 200-209 instead of 200-299 |
| 41 | MEDIUM | shared | errors.ts | Missing undici timeout codes — timeouts misclassified as UNKNOWN |
| 42 | MEDIUM | shared | serialize.ts | CSV-joined tool names unescaped — commas in names corrupt parsing |
| 43 | MEDIUM | mcp-server | cost-tools.ts | `totalTokens` in `report_tokens` handler excludes cache tokens |
| 44 | MEDIUM | mcp-server | weekly-summary.ts | Task success rate averages rates instead of recomputing from totals |
| 45 | MEDIUM | mcp-server | log-ingest.ts | `requeueBatch` drops newest entries, log message says "oldest" |
| 46 | MEDIUM | mcp-server | cross-session-tools.ts | Platform field type coercion fails silently |
| 47 | MEDIUM | mcp-server | claudemd-tracker.ts | Unweighted rate averaging across sessions |
| 48 | MEDIUM | mcp-server | recommendation-engine.ts | Model comparison only checks one direction |
| 49 | MEDIUM | mcp-server | proxy-manager.ts | `decodeURIComponent` throws on malformed URL percent-encoding |
| 50 | MEDIUM | mcp-server | config.ts | Malformed JSON config file returns `{}` — misleading error |
| 51 | MEDIUM | mcp-server | collector-script.ts | `appendFileSync` not atomic for writes > PIPE_BUF |
| 52 | LOW | mcp-server | tool-parsers.ts | `countLines('')` returns 1 instead of 0 |
| 53 | LOW | mcp-server | tool-parsers.ts | Bash `exitCode` as string silently dropped |
| 54 | LOW | mcp-server | collector-script.ts | Token redaction regex lacks word boundary — over-redacts |

---

## Critical Severity

### ✅ 33. `stopPromise` never cleared — restart+stop cycle skips final flush

**File:** `packages/shared/src/harvest/harvest-scheduler.ts:112-118`

```typescript
async stop(): Promise<void> {
  if (this.stopPromise) return this.stopPromise;  // ← returns stale resolved promise
  if (!this.running) return;
  this.stopPromise = this.doStop();
  return this.stopPromise;
}
```

After `doStop()` completes, `this.stopPromise` is never set back to `null`. If the scheduler is restarted via `start()` and then `stop()` is called again, the second `stop()` returns the already-resolved promise from the first call. The second session's final flush never executes — events and metrics are silently dropped.

**Impact:** Any restart+shutdown cycle (e.g., reconnecting after a transient error) loses all buffered data from the second session. The `start()` method does not clear `stopPromise`.

**Fix:** Clear `stopPromise` at the end of `doStop()` or at the beginning of `start()`:

```typescript
start(): void {
  this.stopPromise = null;
  // ... rest of start
}
```

---

### ✅ 34. Pricing table missing current model names — $0 costs for newer models

**File:** `packages/shared/src/pricing-data.ts`

The pricing table contains only dated model IDs:
- `claude-sonnet-4-20250514`
- `claude-opus-4-20250514`
- `claude-haiku-3-5-20241022`

The pricing resolver (`pricing.ts:110-116`) uses prefix matching: `key.startsWith(modelName)`. For current model names like `claude-opus-4-7` or `claude-sonnet-4-6`, the check tests whether `claude-opus-4-20250514`.startsWith(`claude-opus-4-7`) — which is **false** (the key starts with `claude-opus-4-2`, not `claude-opus-4-7`).

**Impact:** All cost tracking for current model names returns $0. The `nr_observe_get_cost_breakdown` tool, cost-per-outcome analysis, and all NR cost events show zero costs. This is the primary cost tracking feature.

**Fix:** Add entries for current model names, or reverse the prefix match direction so the model name's prefix is checked against table keys:

```typescript
// Current: key.startsWith(modelName) — fails for "claude-opus-4-7" vs "claude-opus-4-20250514"
// Better: modelName.startsWith(key_prefix) where key_prefix strips the date suffix
```

Or simply add the new model IDs to the pricing table alongside the dated versions.

---

## High Severity

### ✅ 35. `totalTokens` excludes cache tokens — undercounts by 10-90%

**File:** `packages/shared/src/tokens.ts:59`

```typescript
totalTokens: inputTokens + outputTokens + thinkingTokens,
```

`cacheReadTokens` and `cacheCreationTokens` are extracted (lines 42-47) but not included in the sum. For heavily cached requests (common in Claude Code with prompt caching), cache tokens can represent the majority of token usage.

**Impact:** Token counts reported to NR (`AiResponse.totalTokens`) are systematically undercounted. Cost calculations are NOT affected (they use individual token fields), but any analysis based on `totalTokens` (dashboard queries, trend analysis) shows incorrect data.

**Fix:**

```typescript
totalTokens: inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens,
```

---

### ✅ 36. Retry buffers drop newest events on overflow, keep oldest — log says opposite

**File:** `packages/shared/src/harvest/harvest-scheduler.ts:195-211`

In `harvestEvents()`, the batch sent to NR is constructed as `[...this.retryEventBatch, ...fresh]` — old retries first, then fresh events. When the send fails and `requeueEvents(batch)` is called:

```typescript
private requeueEvents(batch: NrEventData[]): void {
  this.retryEventBatch = [...batch, ...this.retryEventBatch];
  // retryEventBatch was cleared to [] earlier, so this is just [...batch]
  // batch = [old retries, fresh events]
  if (this.retryEventBatch.length > this.maxRetryEvents) {
    this.retryEventBatch = this.retryEventBatch.slice(0, this.maxRetryEvents);
    logger.warn('Event retry buffer overflow — oldest entries dropped', { dropped });
  }
}
```

`slice(0, max)` keeps the first N items — the old retries. The fresh events at the end are dropped. The log says "oldest entries dropped" but it's actually the **newest** events being dropped.

The same bug exists in `requeueMetrics()` (line 204-211).

**Impact:** On sustained send failures, fresh events are dropped while stale retries accumulate. This is backwards — you'd want to keep fresh data and drop entries that have been failing repeatedly.

**Fix:** Either (a) reverse the prepend order so fresh events are first, or (b) use `slice(-maxRetryEvents)` to keep the newest entries.

---

### ✅ 37. Raw tool input/output written to disk regardless of `recordContent` setting

**File:** `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:116-117, 134-135`

```typescript
// Line 117 — ALWAYS stored, no recordContent check
if (data.tool_input !== undefined) event.toolInput = data.tool_input;

// Line 119 — correctly gated by recordContent
if (recordContent && data.tool_input !== undefined) {
  event.inputContent = redact(truncate(content, maxContentLen));
}
```

The `toolInput` and `toolOutput` fields are stored unconditionally (for tool-specific field parsing). The `inputContent` and `outputContent` fields respect `recordContent`. Both are written to the JSONL buffer on disk via `appendFileSync(bufferPath, JSON.stringify(event))`.

**Impact:** When `recordContent=false`, the JSONL buffer still contains full raw tool inputs/outputs — file contents, command outputs, API responses. The `recordContent` flag provides a false sense of privacy control. The raw fields are used by `parseToolSpecificFields()` to extract structured fields (filePath, command), which is legitimate, but the full raw content shouldn't persist on disk.

**Fix:** After parsing tool-specific fields in `event-processor.ts`, delete the raw `toolInput`/`toolOutput` from the event before further processing. Or, in the collector script, extract only the fields needed for parsing (e.g., `filePath`, `command`) rather than storing the entire raw input.

---

### ✅ 38. `linesRemoved` hardcoded to 0 in session summaries

**File:** `packages/nr-ai-mcp-server/src/storage/session-store.ts:275-276`

```typescript
linesAdded: totalLinesChanged,
linesRemoved: 0,
```

The aggregation logic (line 228) only sums `task.linesChanged`, which represents net changes. `linesRemoved` is always zero.

**Impact:** Session summaries, weekly summaries, and any analysis depending on `linesRemoved` always show zero. Code churn metrics are incomplete — only additions are tracked.

**Fix:** Either track removed lines separately through the tool parser pipeline (Edit tool operations can distinguish additions from deletions), or rename the field to make it clear only net changes are tracked.

---

### ✅ 39. Silent upstream connection failures — proxy starts with no working upstreams

**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:96-105`

In `start()`, upstream connection failures are logged but swallowed:

```typescript
for (const upstream of this.upstreams.values()) {
  try {
    await upstream.connect();
  } catch (err) {
    logger.error('Failed to connect upstream', { name: upstream.name, error: String(err) });
    // continues to next upstream — no failure propagation
  }
}
// HTTP server starts on line 122 regardless
```

If ALL upstreams fail to connect, the HTTP server starts successfully. All proxied requests will return 404 "upstream_not_found" errors.

**Impact:** The proxy appears to be running but cannot actually proxy anything. No indication to the user that the system is non-functional. Difficult to debug since the server process is healthy.

**Fix:** Track which upstreams connected successfully. If zero upstreams connected, either reject the start promise or log a prominent warning.

---

## Medium Severity

### ✅ 40. HTTP success range 200-209 instead of 200-299

**File:** `packages/shared/src/transport/http-client.ts:94`

```typescript
if (status >= 200 && status <= 209) {
  return { success: true, statusCode: status, retryCount: attempt };
}
```

HTTP 2xx success codes range from 200-299. The NR APIs currently return 200 or 202, but limiting to 209 is unnecessarily restrictive and inconsistent with HTTP semantics.

**Fix:** `if (status >= 200 && status < 300)`

---

### ✅ 41. Missing undici timeout codes in retry classification

**File:** `packages/shared/src/errors.ts:17`

```typescript
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
```

Missing `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT`. Node.js's built-in fetch (undici) throws these on header/body timeouts. Currently classified as UNKNOWN instead of TIMEOUT, so they won't be retried.

**Fix:** Add to the set:

```typescript
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
```

---

### ✅ 42. CSV-joined tool names unescaped — commas in names corrupt parsing

**File:** `packages/shared/src/events/serialize.ts:22, 54`

```typescript
data.toolNames = event.toolNames.join(',');        // line 22
data.contentBlockTypes = event.contentBlockTypes.join(',');  // line 54
```

If a tool name or content block type contains a comma, the joined string becomes ambiguous when parsed. While standard MCP tool names don't contain commas, custom tools or third-party MCP servers could.

**Fix:** Use a delimiter that's less likely to appear in names (e.g., `|`) or JSON-encode the array.

---

### ✅ 43. `totalTokens` in `report_tokens` handler excludes cache tokens

**File:** `packages/nr-ai-mcp-server/src/tools/cost-tools.ts:61-64`

```typescript
totalTokens:
  args.input_tokens +
  args.output_tokens +
  (args.thinking_tokens ?? 0),
  // missing: (args.cache_read_tokens ?? 0) + (args.cache_creation_tokens ?? 0)
```

Same issue as #35 but in the MCP tool handler rather than the token extraction library. When users manually report tokens via `nr_observe_report_tokens`, cache tokens are excluded from `totalTokens`.

**Fix:** Include cache tokens in the sum:

```typescript
totalTokens:
  args.input_tokens +
  args.output_tokens +
  (args.thinking_tokens ?? 0) +
  (args.cache_read_tokens ?? 0) +
  (args.cache_creation_tokens ?? 0),
```

---

### ✅ 44. Task success rate averages rates instead of recomputing from totals

**File:** `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts:233, 279`

```typescript
taskSuccessRate: totalTestsRun > 0 ? round(totalTestsPassed / totalTestsRun, 3) : 1,
```

When no tests are run (`totalTestsRun === 0`), the success rate defaults to `1` (100%). A week with zero testing shows as 100% success, inflating trend analysis. The same pattern appears at line 279 in `aggregateDeveloperSessions()`.

**Impact:** Weeks/developers with no testing activity show perfect success rates, biasing comparisons and trend lines.

**Fix:** Return `null` when `totalTestsRun === 0` and handle null downstream.

---

### ✅ 45. `requeueBatch` drops newest entries, log message says "oldest"

**File:** `packages/nr-ai-mcp-server/src/transport/log-ingest.ts:147-153`

```typescript
private requeueBatch(batch: NrLogEntry[]): void {
  this.buffer = [...batch, ...this.buffer];
  if (this.buffer.length > this.maxBufferSize) {
    this.buffer = this.buffer.slice(0, this.maxBufferSize);
    logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
  }
}
```

`batch` (the failed send) is prepended, then `slice(0, max)` keeps the first entries. New buffer entries added since the flush started are at the end and get dropped. The log says "oldest entries dropped" but the newest are actually dropped. Same pattern as #36 in the shared package.

---

### ✅ 46. Platform field type coercion fails silently

**File:** `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:431`

```typescript
const platform = (s as Record<string, unknown>).platform as string ?? 'claude-code';
```

The `as string` cast happens before `??`, so if `platform` is `undefined`, the cast produces `undefined` (not a string), and `??` triggers the fallback. However, if `platform` is `null`, the `??` correctly falls back. But if `platform` is a non-string truthy value (e.g., a number), it silently passes through the cast, producing incorrect grouping in platform comparisons.

**Fix:** Use `typeof` check:

```typescript
const platform = typeof (s as Record<string, unknown>).platform === 'string'
  ? (s as Record<string, unknown>).platform as string
  : 'claude-code';
```

---

### ✅ 47. Unweighted rate averaging in CLAUDE.md impact tracker

**File:** `packages/nr-ai-mcp-server/src/metrics/claudemd-tracker.ts:352`

```typescript
taskSuccessSum += s.taskSuccessRate;
// later: taskSuccessSum / sessions.length
```

Averages per-session task success rates without weighting by task count. A session with 1 task at 100% weighs the same as a session with 50 tasks at 60%. The aggregate rate doesn't reflect actual task outcomes.

**Fix:** Weight by task count: `taskSuccessSum += s.taskSuccessRate * s.taskCount`, then divide by total tasks.

---

### ✅ 48. Model comparison only checks one cost direction

**File:** `packages/nr-ai-mcp-server/src/metrics/recommendation-engine.ts:329-330`

```typescript
if (costRatio > 2 && effDiff < 15) {
  const cheaper = costRatio > 1 ? modelArr[1] : modelArr[0];
```

`costRatio = modelACost / modelBCost`. The check `costRatio > 2` only triggers when modelA is significantly more expensive. If modelB is 3x more expensive (`costRatio = 0.33`), no recommendation is generated.

**Fix:** Also check the inverse:

```typescript
const actualRatio = costRatio > 1 ? costRatio : 1 / costRatio;
if (actualRatio > 2 && effDiff < 15) {
  const cheaper = costRatio > 1 ? modelArr[1] : modelArr[0];
```

---

### ✅ 49. `decodeURIComponent` throws on malformed URL percent-encoding

**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:166`

```typescript
const serverName = decodeURIComponent(match[1]);
```

`decodeURIComponent()` throws `URIError` on invalid percent-encoding (e.g., `%ZZ`). Not caught at this level — bubbles to the outer catch block which returns a 500 error.

**Fix:** Wrap in try-catch and return 400:

```typescript
let serverName: string;
try {
  serverName = decodeURIComponent(match[1]);
} catch {
  res.writeHead(400).end(JSON.stringify({ error: 'Invalid server name encoding' }));
  return;
}
```

---

### ✅ 50. Malformed JSON config file returns `{}` — misleading error

**File:** `packages/nr-ai-mcp-server/src/config.ts:67-74`

When the config file exists but contains malformed JSON, `loadConfigFile()` catches the parse error and returns `{}`. Downstream, the empty config merges with defaults, and the user gets a "Missing required configuration: licenseKey" error — not "your config file is broken."

**Fix:** Log a warning when JSON parsing fails:

```typescript
} catch (err) {
  logger.warn('Failed to parse config file — ignoring', {
    filePath,
    error: err instanceof Error ? err.message : String(err),
  });
  return {};
}
```

---

### ✅ 51. `appendFileSync` not atomic for writes > PIPE_BUF

**File:** `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:168`

```typescript
appendFileSync(bufferPath, JSON.stringify(event) + '\n');
```

On POSIX systems, `write()` calls of `PIPE_BUF` bytes or less (typically 4096 bytes on macOS/Linux) are atomic when the file was opened with `O_APPEND`. Larger writes can be interleaved with writes from other processes. If two concurrent Claude Code hook invocations produce large events (e.g., with raw tool input), their JSONL lines can be interleaved, producing corrupt JSON.

**Impact:** Rare in practice — most events are small. Only affects concurrent sessions writing to the same buffer file with large tool inputs.

---

## Low Severity

### ✅ 52. `countLines('')` returns 1 instead of 0

**File:** `packages/nr-ai-mcp-server/src/hooks/tool-parsers.ts:18`

If the implementation counts lines by splitting on newlines, `''.split('\n')` produces `['']` (length 1). An empty string has zero lines.

**Impact:** Minor inflation of line counts for empty files or empty content blocks.

---

### ✅ 53. Bash `exitCode` as string silently dropped

**File:** `packages/nr-ai-mcp-server/src/hooks/tool-parsers.ts:152`

If `exitCode` arrives as a string (e.g., `"0"` from JSON), a `typeof === 'number'` check would silently drop it. Should coerce strings to numbers.

---

### ✅ 54. Token redaction regex lacks word boundary — over-redacts

**File:** `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:47`

The redaction pattern for tokens/keys matches substrings without word boundaries. A field like `tokenizer` or `tokenize` would trigger redaction of content that isn't sensitive.

**Impact:** Over-redaction of benign content in stored events when `recordContent=true`.

---

## Round 3 — Additional Findings (Team Agent Reports)

The following bugs were identified by the original review team agents and are not duplicates of findings #33-54 above.

### ✅ 55. Security alerts bypassed for ALL proxied MCP tool calls

**Severity: CRITICAL**
**File:** `packages/nr-ai-mcp-server/src/security/audit-trail.ts:291-305`

`recordProxyCall()` creates an `AuditRecord` for proxied MCP tool calls but never calls `detectSecurityAlert()` and never extracts `filePath`/`command` from the tool arguments. A proxied MCP tool that executes `rm -rf /` or reads `.env` files generates no security alert.

**Impact:** The proxy is marketed as an observability layer for MCP traffic, but provides zero security oversight of that traffic. The same destructive command flagged as "critical" through the Bash tool is invisible through a proxied MCP server.

**Fix:** Extract tool-specific fields from the proxy call arguments and run `detectSecurityAlert()` before returning the audit record.

---

### ✅ 56. `rm -fr` and `curl | bash` bypass destructive-command detection

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/security/audit-trail.ts:73-84`

`DEFAULT_DESTRUCTIVE_COMMAND_PATTERNS` matches `rm -rf` but not common variants: `rm -fr`, `rm -r -f`, `rm -rvf`. The pipe-to-shell pattern matches `| sh` but not `| bash`, `| zsh`, or `| /bin/sh` — and `curl ... | bash` is the dominant real-world form.

**Impact:** The most common evasions of the documented security controls go undetected.

**Fix:** Broaden the `rm` pattern to match any combination of `-r` and `-f` flags. Broaden the pipe-to-shell pattern to match `bash`, `zsh`, `ksh`, `dash`, and absolute paths.

---

### ✅ 57. `NrIngestManager.start()` has no double-start guard — leaks intervals

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts:303-313`

Calling `start()` twice creates two `setInterval` handles; the first reference is overwritten and never cleared. `stop()` only clears the latest interval. `LogIngestManager.start()` correctly guards with an early return — this class doesn't.

**Impact:** Any restart or test harness reuse leaks intervals and emits session gauges at 2x+ rate.

**Fix:** Add `if (this.running) return;` at top of `start()`.

---

### ✅ 58. Proxy forwards hop-by-hop headers from upstream to client

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:97-103`

`Object.entries(upstreamRes.headers)` copies ALL headers to the client response, including `transfer-encoding`, `connection`, `keep-alive`, and `content-length`. For the non-SSE branch (which buffers the full body and calls `res.end(buf)`), a forwarded `transfer-encoding: chunked` conflicts with Node's computed `content-length`. An incorrect `content-length` from upstream is forwarded as-is even though the proxy re-buffered the body.

**Impact:** Response corruption when clients or intermediary proxies interpret the conflicting framing headers differently.

**Fix:** Filter hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailers`) before `setHeader`. For the non-SSE branch, remove `transfer-encoding` and recompute `content-length` from the buffered body.

---

### ✅ 59. Proxy writes JSON error body into active SSE stream

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:109-117`

When `res.headersSent` is true and `res.writableEnded` is false (SSE stream mid-flow), the error handler calls `res.end(JSON.stringify({...}))`. Writing JSON into an `text/event-stream` response produces a malformed SSE event.

**Fix:** If `res.headersSent && !res.writableEnded`, call `res.socket?.destroy()` instead of writing data.

---

### ✅ 60. Stdio upstream `disconnect()` hangs if `client.close()` hangs

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-stdio.ts:119-126`

`client.close()` is awaited with no timeout. If the upstream MCP server ignores the close request, `disconnect()` hangs forever and the parent process can't exit cleanly.

**Fix:** Race `client.close()` against a timeout (e.g., 5s), then force-kill the child process.

---

### ✅ 61. `EfficiencyScorer.scores` array grows unboundedly — memory leak + duplicate NR emission

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts:64`

```typescript
private readonly scores: EfficiencyScore[] = [];
```

No cap on the array. `emitMetrics()` iterates ALL historical scores on every harvest, re-emitting them to NR. Over long sessions this is both a memory leak and a source of duplicate metric points.

**Fix:** Cap `scores` (e.g., 1000 entries) and track a `lastEmittedIndex` so `emitMetrics()` only sends new scores.

---

### ✅ 62. `ClaudeMdTracker.changes` array grows unboundedly — no reset method

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/metrics/claudemd-tracker.ts:103`

```typescript
private readonly changes: ClaudeMdChange[] = [];
```

No reset method, no bound. Every detected CLAUDE.md write is appended forever. `emitMetrics()` emits a metric per change on every harvest, and every harvest recomputes `computeImpact()` which reads ALL session files from disk.

**Fix:** Bound `changes`, add `lastEmittedIndex`, cache `computeImpact()` until a new change arrives.

---

### ✅ 63. Unbounded latency/size arrays in `ProxyMetricsTracker`

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/metrics/proxy-metrics.ts:37-43`

Per-server latency, request size, and response size arrays grow without limit. `getMetrics()` sorts copies for p95 computation — O(n log n) per call.

**Fix:** Cap per-server arrays (e.g., 1000 entries, keep most recent).

---

### ✅ 64. p95 calculation returns max for small arrays

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts:57-62`

```typescript
const index = Math.floor(sorted.length * 0.95);
return sorted[Math.min(index, sorted.length - 1)]!;
```

For n=10: `floor(10 * 0.95) = 9` → returns the 10th element (max). For n=20: `floor(20 * 0.95) = 19` → returns max. For n=100: `floor(100 * 0.95) = 95` → returns index 95 (the 96th value, which is p96, not p95).

**Impact:** p95 is systematically too high, especially for small arrays where it equals max.

**Fix:** Use `Math.floor((sorted.length - 1) * 0.95)` for nearest-rank.

---

### ✅ 65. `emitMetrics` records mean duration — loses distribution semantics

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts:239-244`

```typescript
aggregator.record('ai.tool.duration_ms', stats.sum / stats.count, { tool });
```

Records the **mean** as a single sample to `MetricAggregator`. NR receives one synthetic value per harvest rather than individual durations. Percentiles and histograms in NR dashboards reflect the sequence of means, not the actual distribution.

**Fix:** Either record each duration individually, or emit `stats.sum` as a summary metric with a separate counter.

---

### ✅ 66. Cost-per-outcome: `Write` tool not recognized as code modification

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts:124`

```typescript
if (tc.toolName === 'Edit' && hasTestFailure) {
  sawEditAfterFailure = true;
}
```

Only `Edit` triggers the "edit after test failure" flag. `Write` (which replaces an entire file) is ignored. A test-fail → Write → test-pass sequence is misclassified as `failed_attempt` instead of `bug_fix`.

**Fix:** `if ((tc.toolName === 'Edit' || tc.toolName === 'Write') && hasTestFailure)`.

---

### ✅ 67. Negative cost delta if `CostTracker` reset mid-task

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/task-detector.ts:339-355`

```typescript
return {
  costUsd: currentCost - this.costAtTaskStart,
  tokens: currentTokens - this.tokensAtTaskStart,
};
```

If `CostTracker.reset()` is called while a task is active, `currentCost` drops to 0 while `costAtTaskStart` retains the pre-reset snapshot. The task's `estimatedCostUsd` becomes negative, corrupting downstream cost-per-outcome and efficiency calculations.

**Fix:** `costUsd: Math.max(0, currentCost - this.costAtTaskStart)`.

---

### ✅ 68. Duplicate efficiency scores when `updateScore` precedes `computeScore`

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts:79-99`

`computeScore()` always pushes to `this.scores`. If `updateScore()` was called first (creating an intermediate entry with the same `taskId`), both entries remain. `getSessionAverage()` averages over both, double-weighting tasks that were previewed live.

**Fix:** Use the same `findIndex` dedup logic in `computeScore` as `updateScore` uses.

---

## Round 3 Recommendation

**Blockers before sharing:**
- **#33** (stopPromise) and **#34** (pricing table) are critical — they render the two main value props (data delivery and cost tracking) non-functional in common scenarios.
- **#55** (proxy security bypass) is a critical gap — proxied MCP tool calls receive no security audit.
- **#35** (totalTokens) and **#36** (retry overflow) affect data correctness in the primary pipeline.
- **#37** (content on disk) is a privacy concern if the tool is shared with users who expect `recordContent=false` to mean no content is stored.

**Before production use:**
- **#38-39** (linesRemoved, silent proxy), **#56** (rm -fr evasion), **#57** (double-start), **#58** (hop-by-hop headers) — incorrect data, security gaps, or operational issues.
- **#40-51, #59-68** (medium severity) — correctness issues in secondary features, memory leaks, error handling gaps, and misleading diagnostics.
- **#61-63** (unbounded arrays) — memory leaks that worsen over long sessions.

**Low priority:** #52-54 are real but have minimal user-visible impact.

---

## Cumulative Statistics

| Round | Date | Critical | High | Medium | Low | Total |
|-------|------|----------|------|--------|-----|-------|
| 1 | 2026-04-20 | 0 | 4 | 6 | 2 | 12 |
| 2 | 2026-04-21 | 0 | 2 | 14 | 4 | 20 |
| 3 | 2026-04-21 | 3 | 10 | 19 | 3 | 35 |
| **Total** | | **3** | **16** | **39** | **9** | **67** |

---

## Round 4 — Entry Points, Config, and Platform Adapters (2026-04-21)

**Scope:** `src/server.ts`, `src/index.ts`, `src/config.ts`, `src/platforms/*` (6 files)
**Reviewers:** 1 agent focused on startup, shutdown, config loading, and cross-platform adapters

### ✅ 69. Audit-log MCP resource unreachable in stdio mode

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/server.ts:81-91`, `src/index.ts:98`

In stdio mode, `createServer()` is called on line 98 with no options. The resource handlers (lines 81-91) close over `options.auditTrailManager`, which is `undefined` at that point. Later, `registerTools()` is called with the real `AuditTrailManager`, but only the tool handlers (`ListToolsRequestSchema`, `CallToolRequestSchema`) are overwritten — the resource handlers are never re-registered.

```typescript
// server.ts:81-83 — captures options at construction time
this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = [];
  if (options.auditTrailManager) {  // always undefined in stdio mode
```

**Impact:** `resources/list` always returns an empty array in stdio mode. The `nr-observe://session/audit-log` resource is dead code.

**Fix:** Either pass `auditTrailManager` into `createServer()` (requires constructing it earlier), re-register resource handlers alongside `registerTools()`, or use a lazy getter.

---

### ✅ 70. `--log-level` CLI flag has no effect

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/index.ts:79`, `src/config.ts:186-192`, `packages/shared/src/logger.ts:10`

`parseArgs` reads `--log-level` and stores it in `config.logLevel`. But `createLogger()` in shared reads a different env var: `NEW_RELIC_AI_LOG_LEVEL` (line 10). Config reads `NEW_RELIC_AI_MCP_LOG_LEVEL` (different name). The resolved `config.logLevel` is never passed to any `createLogger()` call and never written back to the environment.

```typescript
// shared/src/logger.ts:10
const envLevel = process.env.NEW_RELIC_AI_LOG_LEVEL?.toLowerCase();  // reads this

// nr-ai-mcp-server/src/config.ts
logLevel: envLogLevel('NEW_RELIC_AI_MCP_LOG_LEVEL', ...),  // stores from this
```

**Impact:** `--log-level debug` silently does nothing. Documented feature broken.

**Fix:** In `main()`, set `process.env.NEW_RELIC_AI_LOG_LEVEL = config.logLevel` before creating loggers. Or use `createLogger(name, config.logLevel)` — the `levelOverride` parameter already exists but is never used.

---

### ✅ 71. Signal handlers registered after initialization — SIGTERM during startup skips cleanup

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/index.ts:204-205, 257-258`

SIGINT/SIGTERM handlers are registered at lines 204-205 (stdio mode) and 257-258 (proxy mode), AFTER all heavy initialization. If SIGTERM arrives during `connectStdio()`, `loadMcpConfig()`, `localStore.initialize()`, or `nrIngest.start()`, Node uses the default handler and kills the process without cleanup.

In proxy mode, if SIGTERM arrives during `proxyManager.start()` (which can block on stdio child-process spawns for upstream connections), the child processes are leaked.

**Impact:** Lost telemetry on graceful restart during startup window. Leaked child processes in proxy mode.

**Fix:** Register signal handlers first, before any async work, with a guard flag that checks which resources exist before cleaning them up.

---

### ✅ 72. `parseInt` on `--port` produces silent NaN, Node binds random port

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/index.ts:77`

```typescript
port: parseInt(opts.port, 10),
```

If user passes `--port foo`, `parseInt` returns `NaN`. NaN is truthy to `??`, so it wins over env/file defaults. `httpServer.listen(NaN, '127.0.0.1')` — Node treats NaN as 0 and binds a random ephemeral port.

**Impact:** Silent mis-configuration. User asks for a specific port, gets a random one, external integrations fail.

**Fix:** Validate with `Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535`; throw a clear error otherwise.

---

### ✅ 73. Non-array JSON for proxy upstreams silently falls through

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/config.ts:87-103`

`parseProxyUpstreams` tries `JSON.parse(envValue)`. If the env var contains a valid JSON object (not array), the function silently falls through to the file value — the `catch` only fires on parse errors, not on type mismatch. No warning logged.

```typescript
const parsed = JSON.parse(envValue);
if (Array.isArray(parsed)) return parsed;
// else: silently ignored, no warning
```

A user who sets `NEW_RELIC_AI_MCP_PROXY_UPSTREAMS='{"name":"foo",...}'` (forgot the array wrapper) gets zero upstreams and no warning.

**Impact:** Silent config fallback. User hits "No proxy upstreams configured" error despite having set the env var.

**Fix:** Add a warning log when `parsed` is not an array. Also add schema validation on upstream objects (check `name`, `transportType`, `url`/`command` are present).

---

### ✅ 74. CopilotAdapter computes durationMs using raw event.timestamp instead of defaulted value

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/platforms/copilot-adapter.ts:67-71`

```typescript
const timestamp = event.timestamp ?? Date.now();   // defaulted
const durationMs =
  event.endTimestamp !== undefined && event.timestamp !== undefined  // checks raw value
    ? event.endTimestamp - event.timestamp
    : null;
```

If `endTimestamp` exists but `timestamp` is missing, the defaulted `timestamp` (Date.now()) is set on line 67, but the duration calc checks raw `event.timestamp` and returns `null`. Conversely, if `timestamp > endTimestamp` (clock skew), a negative duration is emitted.

**Impact:** Copilot latency metrics missing or negative for events that don't populate `timestamp`.

**Fix:** Use the defaulted `timestamp` variable in the subtraction. Clamp result to `Math.max(0, ...)`.

---

### ✅ 75. CursorAdapter maps `delete_file` to `Write`

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.ts:8-19`

`delete_file: 'Write'` is semantically wrong — Write creates/overwrites files, it doesn't delete. The Windsurf adapter has the same mapping. This skews write-count metrics: every file deletion is counted as a file write.

Additionally, `CursorAdapter` and `WindsurfAdapter` never set `toolUseId` or `inputHash` on normalized events, so re-read detection and thrashing detection in `AntiPatternDetector` cannot work for non-Claude-Code platforms.

**Impact:** Incorrect write counts in cross-platform metrics. Anti-pattern detection non-functional for Cursor/Windsurf.

**Fix:** Either leave `delete_file` unmapped (returns `Unknown`), or add a distinct `'Delete'` normalized name and update consumers.

---

### ✅ 76. GenericMcpAdapter `handleSessionStart` silently drops `developer` field

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/platforms/generic-mcp-adapter.ts:120-125`

The `ReportSessionStartInput` schema accepts `developer` as a field, but `handleSessionStart` only copies `platform` and `model` into `sessionMetadata`. The `developer` field is silently dropped despite being documented in the tool schema.

**Impact:** Documented-but-unimplemented field. Confusing for integrators.

**Fix:** Persist `developer` onto sessionMetadata, or remove it from the schema.

---

### ✅ 77. `loadConfigFile` swallows JSON parse errors

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/config.ts:67-74`

```typescript
function loadConfigFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};  // file-not-found AND malformed JSON both return {}
  }
}
```

If the config file exists but contains malformed JSON, the error is silently swallowed. User edits `config.json`, introduces a typo, server starts with defaults.

**Impact:** Silent config loss.

**Fix:** Distinguish "file not found" (`ENOENT`) from "parse error" (log warning for malformed JSON).

---

### ✅ 78. PlatformRegistry.detect() can reset cached `active` to null

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts:20-32`

`detect()` unconditionally sets `this.active = null` when no adapter's `isSupported()` returns true. If `getActive()` previously cached a valid adapter, and `detect()` is called later in a context where env vars have changed, the cache is silently invalidated.

**Impact:** Minor — recomputed detection on cache miss.

**Fix:** Only set `active = null` if detection has never succeeded, or make `detect()` idempotent.

---

## Round 4 Recommendation

**Before sharing:**
- **#70** (dead `--log-level` flag) is easy to fix and user-facing — set `process.env.NEW_RELIC_AI_LOG_LEVEL` from the resolved config value.
- **#69** (audit-log resource) — users who try to browse MCP resources get nothing. Fix by re-registering resources alongside tools.
- **#71** (signal race) — register handlers early, before async init.

**Before production use:**
- **#72** (NaN port), **#73** (silent proxy config fallback), **#74** (Copilot duration), **#75** (delete_file mapping) — correctness issues in config and platform adapters.

**Low priority:** #76-78 are real but have minimal user-visible impact.

---

## Round 5 — Final Pre-Share Review (2026-04-22)

Five parallel agents performed a comprehensive scan of all source files in `packages/shared/src/` and `packages/nr-ai-mcp-server/src/`. Eleven additional bugs were confirmed.

---

### ✅ 79. `totalTokens` in AiResponse event excludes cache tokens

**Severity: CRITICAL**
**File:** `packages/shared/src/events/factory.ts:109`

`cacheReadTokens` and `cacheCreationTokens` are extracted (lines 107–108) but never added to `totalTokens`:

```typescript
const cacheReadTokens = params.cacheReadTokens ?? 0;         // extracted
const cacheCreationTokens = params.cacheCreationTokens ?? 0; // extracted
const totalTokens = inputTokens + outputTokens + thinkingTokens; // cache tokens missing
```

Every `AiResponse` event sent to New Relic underreports token usage when cache is active. Cost dashboards and per-session cost calculations are wrong for all cache-using requests.

**Fix:** `const totalTokens = inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens;`

---

### ✅ 80. `requeueEvents`/`requeueMetrics` drop the newly-failed batch on overflow (LIFO bug) — FALSE POSITIVE

**Severity: HIGH**
**File:** `packages/shared/src/harvest/harvest-scheduler.ts:197-212`

Both requeue helpers prepend the failed batch then use `slice(-N)` to cap:

```typescript
this.retryEventBatch = [...batch, ...this.retryEventBatch]; // batch at HEAD
this.retryEventBatch = this.retryEventBatch.slice(-this.maxRetryEvents); // keeps TAIL
```

`slice(-N)` keeps the TAIL of the array (the existing old items) and silently drops the HEAD (the newly-failed `batch`). The log message "oldest entries dropped" is incorrect — it is the newest failures that are dropped. On a sustained send outage the retry buffer quickly fills with old data while every newly-failed batch is discarded.

**Investigation result:** This is a false positive. `harvestEvents` unconditionally clears `retryEventBatch = []` (line 147) _before_ the async send, so when `requeueEvents(batch)` is called, the second spread is always empty. The combined array is just `batch` itself — there are no "existing old items" in the tail. `slice(-N)` therefore correctly keeps the newest events within the failed batch, which is the intended behaviour for observability data (confirmed by the existing test: `'caps re-queued events to maxEventBufferSize, keeping newest'`). No code change required.

---

### ✅ 81. MetricAggregator emits `.sum` with `type: 'count'` instead of `type: 'gauge'`

**Severity: MEDIUM**
**File:** `packages/shared/src/harvest/metric-aggregator.ts:60`

```typescript
metrics.push({ ...baseAttrs, type: 'count', name: `${bucket.name}.sum`, value: bucket.sum });
```

New Relic `count` is for monotonically-increasing delta values (requests processed since last flush). A harvest-window sum is a point-in-time aggregation and should be `type: 'gauge'`. New Relic treats them differently: it rate-normalises `count` metrics, making the `.sum` value meaningless in dashboards.

**Fix:** Change `type: 'count'` to `type: 'gauge'` for the `.sum` push on line 60.

---

### ✅ 82. `LogIngestManager.requeueBatch` drops the newly-failed batch on overflow (LIFO bug) — FALSE POSITIVE

**Severity: CRITICAL**
**File:** `packages/nr-ai-mcp-server/src/transport/log-ingest.ts:147-151`

Same LIFO pattern as #80, in the log buffer:

```typescript
this.buffer = [...batch, ...this.buffer];
this.buffer = this.buffer.slice(-this.maxBufferSize); // keeps TAIL, drops newly-failed batch
logger.warn('Log buffer overflow — oldest entries dropped', { dropped }); // message is wrong
```

On overflow, `slice(-N)` keeps the existing buffer (tail) and discards the just-failed `batch` (head). The warning message is wrong — the newest (just-failed) entries are dropped, not the oldest. During a NR API outage, logs accumulate in the existing buffer while every re-queued batch is immediately discarded.

**Fix:** `this.buffer = [...batch, ...this.buffer].slice(0, this.maxBufferSize);` — keeps the failed batch and drops the oldest end of the existing buffer.

**Investigation result:** This is a false positive, for the same reason as #80. `flush()` sets `this.buffer = []` before the async send. Any entries in `this.buffer` when `requeueBatch(batch)` is called are genuinely newer than the failed `batch` — they arrived via `addLog()` while the send was in flight. `slice(-N)` correctly keeps the newest entries (recent arrivals + newer failed items) and drops the oldest, matching the log message and the explicitly documented test assertion: `'Newest entries (highest indices) should survive, oldest dropped'`. No code change required.

---

### ✅ 83. `loadSession` uses substring matching — can return the wrong session

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/storage/session-store.ts:109`

```typescript
if (!file.includes(sessionId)) continue;
```

`String.includes` is a substring check. A session ID of `"abc"` matches `"2024-01-01_abcdef.json"` — a completely different session. If session IDs ever share a common prefix or substring, `loadSession` silently returns the first lexicographic match instead of the intended session.

**Fix:** Use exact-match against the parsed filename: `parseSessionFilename(file)?.sessionId === sessionId`.

---

### ✅ 84. `ByteCountTransform` error handler never resolves the SSE promise — proxy hangs forever

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:136-141`

```typescript
counter.on('error', (err) => {
  logger.error('Stream error in ByteCountTransform', { error: String(err) });
  if (!res.writableEnded) {
    res.socket?.destroy();
  }
  // resolveSSE() is never called
});
```

All other terminal paths for SSE (`end`, `upstreamRes.on('error')`, `res.on('close')`) call `resolveSSE()`. The `counter` error path destroys the socket but leaves the `forward()` Promise unsettled. Any component awaiting `forward()` hangs indefinitely — including `forwardWithInterception()` and ultimately `handleRequest()`.

**Fix:** Add `resolveSSE();` at the end of the `counter.on('error', ...)` handler.

---

### ✅ 85. `CopilotAdapter` maps `file_delete` to `'Write'` instead of `'Delete'`

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/platforms/copilot-adapter.ts:31`

```typescript
const COPILOT_EVENT_TYPE_MAP: Record<string, string> = {
  file_create: 'Write',
  file_delete: 'Write',   // should be 'Delete'
  ...
};
```

This is the same bug that was fixed in `cursor-adapter.ts` and `windsurf-adapter.ts` as part of fix #75, but it was missed in the Copilot adapter. Every Copilot file deletion is counted as a file write, inflating write metrics and suppressing delete metrics.

**Fix:** `file_delete: 'Delete'`

---

### ✅ 86. `cohensD()` returns `Infinity` for zero-variance groups — propagates to effect-size labels

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/prompt-feedback.ts:347`

```typescript
if (pooledSd === 0) return meanA === meanB ? 0 : Infinity;
```

`labelEffectSize(Infinity)` returns `'significant'` because `Math.abs(Infinity) > 0.5` is `true`. When a developer has only identical scores in each group (e.g., all `1`s vs all `2`s — zero within-group variance), Cohen's d is mathematically undefined, yet the code classifies the effect as "significant". This can generate misleading improvement recommendations from zero real data.

**Fix:** Cap the return value: `if (pooledSd === 0) return 0;` — zero-variance groups provide no meaningful effect-size information and should not trigger recommendations.

---

### ✅ 87. `sawEditAfterFailure` reset on subsequent test failures — bug-fix detection broken for multi-failure sequences

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts:115-120`

```typescript
if (tc.success === false) {
  hasTestFailure = true;
  sawEditAfterFailure = false;  // reset on every failure
}
```

For the common real-world pattern `fail → edit → fail → edit → pass`, the second test failure resets `sawEditAfterFailure = false`. The final pass is then never recognized as `bug_fix` (because `sawEditAfterFailure` is `false`), so the task is misclassified as `failed_attempt`. Any session involving more than one test failure before a fix is systematically mislabelled.

**Fix:** Remove the `sawEditAfterFailure = false;` reset. The flag only needs to be set by edits; resetting it on each failure prevents correct detection of multi-failure sequences.

---

### ✅ 88. `pairingKey()` fallback collides for parallel same-tool calls with no `toolUseId`

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/hooks/event-processor.ts:258-263`

```typescript
private pairingKey(event: HookEvent): string {
  const toolUseId = event.toolUseId as string | undefined;
  if (toolUseId) return toolUseId;
  return `${event.tool}:${event.timestamp}`;  // collision risk
}
```

When Claude issues parallel tool calls (e.g., two simultaneous `Read` calls), both `PreToolUse` events may share the same tool name and millisecond timestamp. They get the same key; the second event silently overwrites the first in `this.pending`. One tool call is permanently lost from all metrics, cost calculations, and anti-pattern detection.

**Fix:** Append a monotonically-increasing fallback counter: `${event.tool}:${event.timestamp}:${this.fallbackSeq++}` (initialize `private fallbackSeq = 0` in the class).

---

### ✅ 89. `CallToolRequestSchema` handler has no top-level try-catch — unhandled exceptions crash the MCP server

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/tools/session-stats.ts:248`

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    // 20+ case branches, each calling getMetrics() on optional trackers
  }
  // no surrounding try-catch
});
```

If any branch throws (unexpected tracker state, type error, etc.), the exception escapes to the MCP SDK. Depending on SDK version it may close the stdio transport, crashing the server and ending the Claude Code session. The handler is the single point of failure for all MCP tool calls.

**Fix:** Wrap the switch body in a try-catch that returns `{ content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }] }`.

---

## Round 5 Recommendation

**Critical (fix before sharing):**
- **#79** (`totalTokens` missing cache terms) — every cache-heavy session reports wrong token counts in New Relic. One-line fix.
- **#82** (log requeue LIFO) — logs are silently discarded on API outage rather than retried.

**High (fix before production):**
- **#80** (event/metric requeue LIFO) — same data-loss pattern in the core harvest path.
- **#84** (SSE promise hang) — proxy can deadlock on stream errors in production.
- **#87** (bug-fix detection) — most real bug-fix sessions are misclassified as failed.
- **#88** (pairingKey collision) — parallel tool calls (common in Claude Code) lose data.
- **#83** (substring session match) — wrong session data returned on ID prefix collision.

**Medium (nice-to-have):**
- **#81** (`.sum` metric type), **#85** (Copilot delete mapping), **#86** (Infinity Cohen's d), **#89** (no try-catch in tool handler).

---

## Round 6

**Date:** 2026-04-22
**Scope:** Final full-source review of `packages/nr-ai-mcp-server/src/` and `packages/shared/src/`
**Method:** Five parallel Explore agents, each covering a distinct subsystem, with manual verification of all findings.

---

### ✅ 90. `readBody()` missing `close` event handler — proxy request can hang forever

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:311-322`

```typescript
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET') {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // no 'close' listener
  });
}
```

Node.js `IncomingMessage` emits `close` when the underlying socket closes. If a client aborts mid-request (network drop, timeout, client disconnect), `close` fires but `end` may never fire. The Promise returned by `readBody()` then never settles. `handleRequest()` awaits it indefinitely, leaking the connection slot permanently for that request.

**Fix:** Add a `close` listener that resolves with whatever chunks arrived:
```typescript
let settled = false;
const settle = (buf: Buffer) => { if (!settled) { settled = true; resolve(buf); } };
req.on('end',   () => settle(Buffer.concat(chunks)));
req.on('close', () => settle(Buffer.concat(chunks)));
req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts` — Replace the `readBody()` implementation with the settled-flag pattern. Add `let settled = false` and a `settle` helper that only resolves once. Wire `end` and `close` through `settle`, and check `!settled` in the `error` handler before rejecting.
2. `packages/nr-ai-mcp-server/src/proxy/proxy-manager.test.ts` — Add a test that simulates a client abort mid-request: emit `close` without `end` and assert the promise resolves (rather than hanging) with the partial chunks received so far.

---

### ✅ 91. `local-store.ts` drain recovery concatenates files without newline separator — data loss

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/storage/local-store.ts:72`

```typescript
writeFileSync(this.bufferPath, drainData + bufferData);
```

When recovering from a previous interrupted drain, the `.drain` file content is prepended to the current buffer file content. If `drainData` does not end with `\n` (possible if the preceding write was interrupted mid-line), the last line of the drain file and the first line of the buffer file are concatenated into a single malformed JSON string. The line-by-line parser later silently skips it (`Skipping malformed buffer line`), losing both events.

**Fix:**
```typescript
writeFileSync(
  this.bufferPath,
  drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData,
);
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/storage/local-store.ts` (line 72) — Change the drain recovery concatenation to insert a newline between `drainData` and `bufferData` when `drainData` does not already end with `\n`, using the ternary from the fix.
2. `packages/nr-ai-mcp-server/src/storage/local-store.test.ts` — Add a test: write two JSONL events to the drain file without a trailing newline, trigger drain recovery, and assert both events parse cleanly (no malformed-line skips).

---

### ✅ 92. `countLines('')` returns 1 in `collector-script.ts` — fix #52 not applied here

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:83-84, 124, 130`

```typescript
function countLines(text: string): number {
  return (text.match(/\n/g) || []).length + 1;  // returns 1 for ""
}
```

Fix #52 corrected this in `tool-parsers.ts` but the same function in `collector-script.ts` was not updated. Additionally, lines 124 and 130 call `countLines` directly without the `> 0` guard that was added on line 134:

```typescript
// line 124 — unguarded:
meta.lineCount = countLines(obj.content);
// line 130 — unguarded:
meta.oldLineCount = countLines(obj.old_string);
// line 134 — has guard:
meta.newLineCount = obj.new_string.length > 0 ? countLines(obj.new_string) : 0;
```

Writing an empty file records `lineCount = 1` instead of 0. Deleting all content in an Edit records `oldLineCount = 1`. Both inflate linesChanged metrics and cost-per-line-of-code calculations.

**Fix:** Add the same guard to lines 124 and 130:
```typescript
meta.lineCount    = obj.content.length    > 0 ? countLines(obj.content)    : 0;
meta.oldLineCount = obj.old_string.length > 0 ? countLines(obj.old_string) : 0;
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/hooks/collector-script.ts` — Fix the `countLines` function to return `0` for an empty string (change `return (text.match(/\n/g) || []).length + 1` to `return text.length === 0 ? 0 : (text.match(/\n/g) || []).length + 1`). Also add the `> 0` guard to lines 124 and 130 for `meta.lineCount` and `meta.oldLineCount`, matching the guard already present at line 134 for `meta.newLineCount`.
2. `packages/nr-ai-mcp-server/src/hooks/collector-script.test.ts` — Add tests: `countLines('')` returns 0; a Write event with empty content yields `lineCount = 0`; an Edit event with empty `old_string` yields `oldLineCount = 0`.

---

### ✅ 93. `lastEditFile` not cleared when Edit/Write lacks `filePath` — thrashing mis-attributed

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts:119-123`

```typescript
if (call.toolName === 'Edit' || call.toolName === 'Write') {
  const file = call.filePath as string | undefined;
  if (file) {
    lastEditFile = file;   // only updated when filePath present
  }
  // if file is undefined: lastEditFile retains previous value
}
```

If an Edit/Write call arrives without a `filePath` (e.g., a hook parse failure), `lastEditFile` is not updated and retains the previous file's path. When the subsequent test command fails, the thrashing cycle count is incremented for the wrong file — the stale one from the earlier Edit.

**Failure scenario:** Edit fileA → Edit fileB (no filePath) → Bash test FAIL → fileA's cycle count incremented, even though the last edit targeted fileB.

**Fix:** Clear `lastEditFile` when `filePath` is absent:
```typescript
if (file) {
  lastEditFile = file;
} else {
  lastEditFile = null;
}
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts` (`detectThrashing`) — In the `Edit`/`Write` branch, add an `else` clause that sets `lastEditFile = null` when `filePath` is absent.
2. `packages/nr-ai-mcp-server/src/metrics/anti-patterns.test.ts` — Add a test: Edit fileA (with filePath) → Edit fileB (no filePath) → Bash test FAIL × threshold. Assert no thrashing pattern is emitted for fileA (because the no-filePath edit cleared `lastEditFile`).

---

### ✅ 94. Investigation classification boundary off-by-one: `> 0.8` should be `>= 0.8`

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts:166`

```typescript
if (readCount / task.toolCallCount > 0.8) {
  return 'investigation';
}
```

A task with exactly 80% read/search tool calls (e.g., 4 Read + 1 Write = 5 total, ratio = 0.8) fails the `> 0.8` test and falls through to `'feature'`. The design intent is "mostly read/search tools", which 80% clearly satisfies. Using `> 0.8` silently misclassifies exact-boundary tasks.

**Fix:** `if (readCount / task.toolCallCount >= 0.8) {`

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts` (line 166) — Change `> 0.8` to `>= 0.8` in the investigation classification condition.
2. `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.test.ts` — Add a boundary test: a task with exactly 4 Read + 1 Write (ratio = 0.8) should be classified as `'investigation'`, not `'feature'`.

---

### ✅ 95. `taskSuccess` defaults to `1` when no tests run — reported as 100% success

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts:175`

```typescript
taskSuccess: totalTestsRun > 0 ? round(totalTestsPassed / totalTestsRun, 3) : 1,
```

When a week has no test runs, `taskSuccess` is set to `1` (100%). This value propagates into weekly summaries, trend deltas (`aggB.taskSuccess - aggA.taskSuccess`), and the `generateWeekSummary()` report (line 346: `agg.taskSuccess * 100`). A week with no testing is reported as having perfect task success, inflating trend scores and masking gaps.

**Fix:** Return `0` instead of `1` to indicate no test data:
```typescript
taskSuccess: totalTestsRun > 0 ? round(totalTestsPassed / totalTestsRun, 3) : 0,
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts` (line 175) — Change the default from `: 1` to `: 0` in the `taskSuccess` ternary.
2. `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.test.ts` — Add a test: a week aggregate with `totalTestsRun = 0` should have `taskSuccess = 0`, not `1`. Also verify the trend delta for two no-test-run weeks is `0` rather than `0` masking a `1 - 1` calculation.

---

### ✅ 96. `shutdown()` handler has no try-catch — cleanup failures prevent `process.exit`

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/index.ts:111-120`

```typescript
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  eventProcessor?.stop();
  if (nrIngest) await nrIngest.stop();      // ← can throw
  if (mcpServer) await mcpServer.close();   // ← can throw
  if (proxyManager) await proxyManager.stop(); // ← can throw
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

The signal handler calls `shutdown()` without awaiting (signal handlers cannot await). If any of the three `await` calls throws (e.g., `nrIngest.stop()` fails to flush final metrics due to a network error), the Promise rejects. Node.js emits an `unhandledRejection` event — and in modern Node.js (≥ 15) this terminates the process with exit code 1, skipping the remaining cleanup steps and `process.exit(0)`.

**Fix:** Wrap cleanup in try-catch and put `process.exit(0)` in a `finally` block:
```typescript
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  try {
    eventProcessor?.stop();
    if (nrIngest) await nrIngest.stop();
    if (mcpServer) await mcpServer.close();
    if (proxyManager) await proxyManager.stop();
  } catch (err) {
    logger.error('Error during shutdown cleanup', { error: String(err) });
  } finally {
    process.exit(0);
  }
};
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/index.ts` (lines 111–120) — Wrap the three `await` calls inside `shutdown()` in a `try/catch`. Move `process.exit(0)` into a `finally` block so it is always reached regardless of which cleanup step throws.
2. `packages/nr-ai-mcp-server/src/index.test.ts` (or integration test) — Add a test: mock `nrIngest.stop()` to throw, call `shutdown()`, and assert that `process.exit` is still called with code 0 and the error is logged.

---

### ✅ 97. `GenericMcpAdapter` missing `input_size_bytes` — input size metrics silently lost

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/platforms/generic-mcp-adapter.ts:8-16, 28-47, 101-117`

The `ReportToolCallInput` interface and the `REPORT_TOOL_CALL_TOOL` schema do not include an `input_size_bytes` field. Every other adapter (`ClaudeCodeAdapter`, `CursorAdapter`, `WindsurfAdapter`, `CopilotAdapter`) extracts and propagates `inputSizeBytes` from their native event data. Users of the generic adapter (platforms without a dedicated adapter) have no way to report tool input size, so `inputSizeBytes` is always `undefined` for their tool calls. Cost-per-byte metrics and proxy overhead metrics derived from input size will be incomplete.

**Fix:** Add `readonly input_size_bytes?: number;` to `ReportToolCallInput`, add `input_size_bytes: { type: 'number', description: 'Size of tool input in bytes' }` to the schema `properties`, and extract it in `normalizeToolCall()`:
```typescript
...(input.input_size_bytes !== undefined && { inputSizeBytes: input.input_size_bytes }),
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/platforms/generic-mcp-adapter.ts` — Add `readonly input_size_bytes?: number;` to `ReportToolCallInput`. Add the `input_size_bytes` property to `REPORT_TOOL_CALL_TOOL.inputSchema.properties`. In `normalizeToolCall()`, spread `inputSizeBytes` from `input.input_size_bytes` using the optional spread pattern.
2. `packages/nr-ai-mcp-server/src/platforms/generic-mcp-adapter.test.ts` — Add a test: call `normalizeToolCall` with `input_size_bytes: 512` and assert `normalized.inputSizeBytes === 512`. Also assert it is `undefined` when `input_size_bytes` is omitted.

---

### ✅ 98. Gemini fallback `totalTokens` omits `cacheCreationTokens` — inconsistent formula

**Severity: LOW**
**File:** `packages/shared/src/tokens.ts:186-192`

```typescript
this.latestUsage.totalTokens =
  meta.totalTokenCount !== undefined
    ? safeInt(meta.totalTokenCount)
    : this.latestUsage.inputTokens +
      this.latestUsage.outputTokens +
      this.latestUsage.thinkingTokens +
      this.latestUsage.cacheReadTokens;
      // missing: + this.latestUsage.cacheCreationTokens
```

The Anthropic path (line 59) sums all five token types including `cacheCreationTokens`. The Gemini fallback only sums four. Gemini currently does not expose cache creation tokens (the field stays 0), so there is no incorrect value produced today. However, if Gemini adds support for this field in a future API version, the fallback would silently undercount.

**Fix:** Add the missing term: `+ this.latestUsage.cacheCreationTokens`

**Implementation Plan:**
1. `packages/shared/src/tokens.ts` (line ~190) — In the Gemini fallback `totalTokens` calculation, add `+ this.latestUsage.cacheCreationTokens` to match the Anthropic path formula.
2. `packages/shared/src/tokens.test.ts` — Add a test: provide Gemini usage metadata with `cacheCreationTokens > 0` and no `totalTokenCount` from the API, and assert the computed `totalTokens` equals `inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens`.

---

## Round 6 Recommendation

**High (fix before production use):**
- **#90** (`readBody()` missing close handler) — a single aborted client request leaks a connection slot permanently; under load, this could exhaust server resources.
- **#96** (shutdown no try-catch) — a flush error during SIGTERM causes `process.exit(0)` to be skipped; MCP session ends uncleanly.

**Medium (fix before wider sharing):**
- **#92** (countLines in collector-script) — inflates line-count metrics for empty-file writes/edits; fix #52 only applied to tool-parsers.
- **#91** (drain recovery newline) — rare data loss on interrupted buffer writes; only matters if disk is stressed.
- **#93** (thrashing mis-attribution) — wrong file blamed in thrashing reports when a hook parse fails to extract filePath.
- **#94** (investigation boundary) — 80%-read tasks misclassified; off-by-one at the boundary.
- **#95** (taskSuccess defaults to 1) — weeks with no tests appear 100% successful in trend charts.
- **#97** (generic adapter input size) — input size metrics unavailable for non-native-platform users.

**Low:**
- **#98** (Gemini token formula inconsistency) — no wrong value today, but formula diverges from the Anthropic path for future-proofing.

---

---

## Round 7 — Final Comprehensive Review (2026-04-22)

**Scope:** All source files in `packages/nr-ai-mcp-server/src/` and `packages/shared/src/` not exhaustively covered in prior rounds
**Reviewers:** 6 parallel agents covering shared/transport, shared/events+pricing, metrics analytics, metrics core, tools+storage, transport+security+platforms
**Finding numbers:** #99–110

### ✅ 99. `res.end()` without `res.writeHead()` on non-SSE upstream error with no data

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:207-213`

In the non-SSE response error handler, when an upstream error fires before any data chunks arrive, the code calls `res.end()` without first calling `res.writeHead(statusCode)`. Node.js auto-generates a 200 OK response header, so the client receives a successful 200 empty response for a failed upstream request.

```typescript
upstreamRes.on('error', (err) => {
  const bytesAlreadySent = chunks.reduce((sum, c) => sum + c.length, 0);
  if (bytesAlreadySent > 0 && !res.writableEnded) {
    res.socket?.destroy();
  } else if (!res.writableEnded) {
    res.end();   // ← no writeHead — Node auto-sends 200 OK
  }
  ...
});
```

Note: the related finding #7 covers the case where chunks WERE already received (data loss). This covers the no-data case (wrong status).

**Impact:** Clients cannot distinguish upstream failure from empty success. Errors appear as successful responses.

**Fix:**
```typescript
} else if (!res.writableEnded) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'upstream_error', message: String(err) }));
}
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts` (lines 207–213) — In the `upstreamRes.on('error', ...)` handler, in the `bytesAlreadySent === 0` branch, call `res.writeHead(statusCode, { 'content-type': 'application/json' })` before `res.end(JSON.stringify({ error: 'upstream_error', message: String(err) }))`. Ensure `statusCode` is the upstream response status code captured at connection time (typically 502 or the upstream's code).
2. `packages/nr-ai-mcp-server/src/proxy/upstream-http.test.ts` — Add a test: simulate an upstream error before any data chunks arrive, assert the client response has a non-200 status code and a JSON body with an `error` field.

---

### ✅ 100. `requeueBatch` in `LogIngestManager` prepends failed batch then drops it on overflow

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/transport/log-ingest.ts:147-153`
**Fixed by:** commit `ed83a16` (Fix B-01)

When a log batch fails to send and is re-queued, the failed batch is prepended to `this.buffer`, then `.slice(-maxBufferSize)` keeps only the LAST `maxBufferSize` items. The prepended failed batch ends up at the front and is the first to be dropped when overflow occurs.

```typescript
private requeueBatch(batch: NrLogEntry[]): void {
  this.buffer = [...batch, ...this.buffer];                    // ← prepend (now at front = oldest)
  if (this.buffer.length > this.maxBufferSize) {
    this.buffer = this.buffer.slice(-this.maxBufferSize);      // ← keeps last N — drops the front (the failed batch)
    logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
  }
}
```

The same pattern exists in `harvest-scheduler.ts` `requeueEvents()` (documented in security audit B-01). This is the second occurrence.

**Impact:** Under buffer pressure, the batch that just failed to reach New Relic is silently dropped, defeating the retry mechanism.

**Fix applied:** Changed prepend to append; `slice(-N)` is correct with the append order — the failed batch is at the tail and `slice(-N)` keeps the tail. (The implementation plan's suggestion to change `slice(-N)` to `slice(0, N)` would have been incorrect and dropped the batch; it was not applied.)

**Tests:** `log-ingest.test.ts` — "caps buffer at maxBufferSize on overflow" verifies that the 1100-entry buffer is capped at 1000, newest entries survive, and oldest are dropped.

---

### ✅ 101. `error_rate` platform comparison uses `taskSuccessRate` (test pass rate) instead of tool call success rate

**Severity: HIGH**
**File:** `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:461-467`

The `error_rate` metric in `handleGetPlatformComparison` uses `s.taskSuccessRate` (the fraction of test runs that passed) as a proxy for tool error rate. These are unrelated: a session where all tools succeed but no tests pass would report high error_rate, and a session with many tool failures but no tests run would report 0% error_rate (because `taskSuccessRate ?? 1` defaults to 1.0 when no tests were run).

```typescript
case 'error_rate': {
  const total = platformSessions.reduce((sum, s) => {
    const tc = s.toolCallCount ?? 0;
    const successRate = s.taskSuccessRate ?? 1;   // ← taskSuccessRate is TEST pass rate, not tool success
    return sum + (tc > 0 ? (1 - successRate) : 0);
  }, 0);
  value = Math.round((total / count) * 100) / 100;  // ← also unweighted by tc
  break;
}
```

Note: the unweighted formula was independently documented in security audit B-02. The wrong-field issue is distinct.

**Impact:** Platform comparison error_rate metric is meaningless. Platforms with no test runs always appear to have 0% error rate.

**Fix:** Use a tool-level success field (e.g., `s.overallSuccessRate`) and weight by tool call count:
```typescript
case 'error_rate': {
  let weightedErrors = 0, totalTc = 0;
  for (const s of platformSessions) {
    const tc = s.toolCallCount ?? 0;
    const errorRate = 1 - (s.overallSuccessRate ?? 1);
    weightedErrors += tc * errorRate;
    totalTc += tc;
  }
  value = totalTc > 0 ? Math.round((weightedErrors / totalTc) * 100) / 100 : 0;
  break;
}
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/storage/session-store.ts` — Ensure `FullSessionSummary` includes an `overallSuccessRate` field (the tool call-level success rate). If `SessionTracker.getMetrics().toolSuccessRate` is already persisted per session, map it to `overallSuccessRate` when saving. If not, add it.
2. `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts` (`error_rate` case) — Replace the `taskSuccessRate`-based calculation with a weighted tool-call success rate using `s.overallSuccessRate ?? 1` and weight by `s.toolCallCount ?? 0`, matching the fix code above.
3. `packages/nr-ai-mcp-server/src/tools/cross-session-tools.test.ts` — Add a test: two platforms where one has 0 test runs (previously showing 0% error despite 50% tool failure) now correctly shows tool-level error rate. Assert the metric reflects tool failures, not test outcomes.

---

### ✅ 102. `generationDurationMs` can be negative when thinking exceeds total duration

**Severity: MEDIUM**
**File:** `packages/shared/src/timing.ts:75`

```typescript
const generationDurationMs = durationMs - (thinkingDurationMs ?? 0);
```

If `markThinkingEnd()` is called after `stop()` (e.g., due to ordering issues in streaming callbacks), `thinkingDurationMs` can exceed `durationMs`, producing a negative `generationDurationMs`. The adjacent `overheadMs` calculation already guards against this with `Math.max(0, ...)` at line 82 — but `generationDurationMs` has no such guard.

**Impact:** Negative `generationDurationMs` emitted to New Relic corrupts the generation time metric, and any code dividing by this value would produce incorrect results.

**Fix:**
```typescript
const generationDurationMs = Math.max(0, durationMs - (thinkingDurationMs ?? 0));
```

**Implementation Plan:**
1. `packages/shared/src/timing.ts` (line 75) — Wrap the `generationDurationMs` assignment in `Math.max(0, ...)` to match the guard already applied to `overheadMs` at line 82.
2. `packages/shared/src/timing.test.ts` — Add a test: call `markThinkingEnd()` after `stop()` so that `thinkingDurationMs > durationMs`, and assert `generationDurationMs === 0` (not negative).

---

### ✅ 103. `percentChange(0, X)` returns 0 instead of representing infinite growth

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts:103-106`

```typescript
export function percentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;   // ← reports "no change" when going from $0 to $50
  return round(((newValue - oldValue) / Math.abs(oldValue)) * 100, 1);
}
```

When `oldValue === 0` and `newValue > 0`, the function returns 0 (0% change). This is used in trend reports comparing week-over-week cost and efficiency: a team that went from $0 to $50 spend, or from 0 sessions to 10 sessions, appears to have no trend change.

**Impact:** Trend comparisons from a zero baseline are silently suppressed. New adopters or teams resuming after a break show 0% change in all trend metrics.

**Fix:**
```typescript
export function percentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return newValue === 0 ? 0 : null as unknown as number; // caller should handle null
  return round(((newValue - oldValue) / Math.abs(oldValue)) * 100, 1);
}
```

Or return a sentinel value and update callers to display "N/A" when `oldValue === 0 && newValue !== 0`.

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.ts` — Change `percentChange` to return `null` (typed `number | null`) when `oldValue === 0 && newValue !== 0`. Update the return type signature and all callers that render trend deltas to display `"N/A"` or omit the field when the result is `null`.
2. `packages/nr-ai-mcp-server/src/metrics/trend-analyzer.test.ts` — Add tests: `percentChange(0, 50)` returns `null`; `percentChange(0, 0)` returns `0`; `percentChange(10, 20)` returns `100`.

---

### ✅ 104. `classify()` misclassifies "Learning" — missing autonomy check

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/collaboration-profile.ts:274`

```typescript
function classify(dimensions: ProfileDimensions): string {
  const { specificity, autonomy, correctionRate } = dimensions;

  if (specificity >= 0.6 && autonomy >= 0.6) return 'Power User';
  if (specificity < 0.6 && autonomy >= 0.6) return 'Delegator';
  if (specificity < 0.6 && correctionRate < 0.6) return 'Learning';  // ← missing: && autonomy < 0.6
  return 'Collaborative';
}
```

A developer with low specificity (0.4), HIGH autonomy (0.8), and low correction rate (0.3) falls through the "Power User" and "Delegator" checks (second branch requires `specificity < 0.6 && autonomy >= 0.6` → true, so this is actually caught). But a developer with specificity = 0.5, autonomy = 0.7, correctionRate = 0.4:
- Branch 1: `0.5 >= 0.6` → false
- Branch 2: `0.5 < 0.6 && 0.7 >= 0.6` → **true → "Delegator"**

Actually the real gap is: specificity = 0.5, autonomy = 0.59, correctionRate = 0.4:
- Branch 1: false
- Branch 2: `0.5 < 0.6 && 0.59 >= 0.6` → false
- Branch 3: `0.5 < 0.6 && 0.4 < 0.6` → **true → "Learning"** ← but autonomy = 0.59 is near-high autonomy, should be "Collaborative"

**Impact:** Developers with moderate-to-high autonomy but low specificity and correction rate are incorrectly labelled "Learning" instead of "Collaborative". Coaching recommendations for "Learning" profiles are inappropriate for these users.

**Fix:**
```typescript
if (specificity < 0.6 && autonomy < 0.6 && correctionRate < 0.6) return 'Learning';
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/collaboration-profile.ts` (line 274, `classify()`) — Add `&& autonomy < 0.6` to the "Learning" branch condition so that users with moderate-to-high autonomy fall through to "Collaborative" instead.
2. `packages/nr-ai-mcp-server/src/metrics/collaboration-profile.test.ts` — Add a test: specificity = 0.5, autonomy = 0.59, correctionRate = 0.4 should classify as `'Collaborative'`, not `'Learning'`. Also verify the existing "Learning" classification still fires for specificity = 0.4, autonomy = 0.3, correctionRate = 0.3.

---

### ✅ 105. Empty `effectSizes` array causes `overallLabel` to default to `'significant'`

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/metrics/prompt-feedback.ts:198-203`

When there are insufficient sessions before or after a CLAUDE.md change (e.g., the change was made in the very first session), `effectSizes` is empty. The majority-vote logic then evaluates `0 >= 0 && 0 >= 0 === true` and sets `overallLabel = 'significant'`:

```typescript
const labelCounts = { significant: 0, moderate: 0, noise: 0 };
for (const es of effectSizes) labelCounts[es.label]++;   // no-op for empty array

let overallLabel: EffectSize['label'] = 'noise';
if (labelCounts.significant >= labelCounts.moderate && labelCounts.significant >= labelCounts.noise) {
  overallLabel = 'significant';    // ← 0 >= 0 && 0 >= 0 → true
} else if (labelCounts.moderate >= labelCounts.noise) {
  overallLabel = 'moderate';
}
```

**Impact:** CLAUDE.md impact reports return "significant" when there is literally no data to support the claim. Users may act on the recommendation (revert CLAUDE.md, keep CLAUDE.md) based on a phantom significance verdict.

**Fix:**
```typescript
let overallLabel: EffectSize['label'] = 'noise';
if (effectSizes.length > 0) {
  if (labelCounts.significant >= labelCounts.moderate && labelCounts.significant >= labelCounts.noise) {
    overallLabel = 'significant';
  } else if (labelCounts.moderate >= labelCounts.noise) {
    overallLabel = 'moderate';
  }
}
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/prompt-feedback.ts` (lines 198–203) — Wrap the entire `if`/`else if` majority-vote block in `if (effectSizes.length > 0) { ... }`, so that an empty array leaves `overallLabel` at its `'noise'` default rather than entering the `0 >= 0` branch.
2. `packages/nr-ai-mcp-server/src/metrics/prompt-feedback.test.ts` — Add a test: call the CLAUDE.md impact analysis with a change that has no sessions before or after it (empty `effectSizes`), and assert `overallLabel === 'noise'`, not `'significant'`.

---

### ✅ 106. `listSessions()` sort is unstable for same-day sessions

**Severity: MEDIUM**
**File:** `packages/nr-ai-mcp-server/src/storage/session-store.ts:149`

```typescript
return results.sort((a, b) => a.date.localeCompare(b.date));
```

Multiple sessions on the same calendar day produce equal sort keys. JavaScript's `Array.sort` is not guaranteed to be stable across all engines for equal elements (and even in engines where it is stable, the order depends on the order files were read from the directory — which is filesystem-dependent). Callers relying on consistent ordering (pagination, trend analysis using "most recent N sessions") may see different results across runs.

**Impact:** Trend analysis and weekly summaries can include different sessions depending on filesystem readdir order, producing non-deterministic metrics.

**Fix:** Add `sessionId` as a secondary sort key (session IDs contain timestamps):
```typescript
return results.sort(
  (a, b) => a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId),
);
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/storage/session-store.ts` (line 149) — Change the sort comparator to use `a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId)` so same-day sessions are sorted deterministically by session ID as a tiebreaker.
2. `packages/nr-ai-mcp-server/src/storage/session-store.test.ts` — Add a test: create three sessions with the same `date` field but different `sessionId` values, call `listSessions()`, and assert they are returned in consistent lexicographic session ID order on repeated calls.

---

## Low Severity

### ✅ 107. `truncateErrorMessage` violates its length contract when `maxLength < 4`

**Severity: LOW**
**File:** `packages/shared/src/errors.ts:185-188`

```typescript
export function truncateErrorMessage(message: string, maxLength = 1024): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - 3) + '...';
}
```

When `maxLength < 4`, `maxLength - 3` is 0 or negative. `'hello'.slice(0, -1)` returns `'hell'`, so the result `'hell' + '...'` is 7 characters — longer than the requested `maxLength = 2`. The function's stated contract (truncate to `maxLength`) is violated.

**Impact:** Low in practice since the default is 1024 and callers rarely pass small values. But any defensive caller checking the returned length against `maxLength` will see unexpected behavior.

**Fix:**
```typescript
export function truncateErrorMessage(message: string, maxLength = 1024): string {
  const safeMax = Math.max(4, maxLength);
  if (message.length <= safeMax) return message;
  return message.slice(0, safeMax - 3) + '...';
}
```

**Implementation Plan:**
1. `packages/shared/src/errors.ts` (`truncateErrorMessage`) — Add `const safeMax = Math.max(4, maxLength);` and replace all uses of `maxLength` in the function body with `safeMax`.
2. `packages/shared/src/errors.test.ts` — Add tests: `truncateErrorMessage('hello', 2)` returns a string of length ≤ 4 (clamped to `safeMax`); `truncateErrorMessage('hello', 4)` returns `'h...'`; the default behavior with a long string is unchanged.

---

### ✅ 108. Token estimation in `recordEstimatedTokens` independently rounds each component, accumulating drift in `totalTokens`

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts:72-80`

```typescript
const usage: TokenUsage = {
  inputTokens:  Math.round(inputChars / 4),
  outputTokens: Math.round(outputChars / 4),
  ...
  totalTokens: Math.round(inputChars / 4) + Math.round(outputChars / 4),  // ← rounding applied twice
};
```

`Math.round(inputChars / 4) + Math.round(outputChars / 4)` is not guaranteed to equal `Math.round((inputChars + outputChars) / 4)`. For example, `Math.round(1/4) + Math.round(1/4) = 0 + 0 = 0` while `Math.round(2/4) = 1`. Over thousands of estimated calls, `totalTokens` can drift from the sum of its components.

**Impact:** `totalTokens` is used to derive cost; small rounding errors accumulate into reportable cost discrepancies across long sessions.

**Fix:**
```typescript
const inputTokens = Math.round(inputChars / 4);
const outputTokens = Math.round(outputChars / 4);
const usage: TokenUsage = {
  inputTokens,
  outputTokens,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: inputTokens + outputTokens,
};
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts` (`recordEstimatedTokens`) — Hoist `Math.round(inputChars / 4)` and `Math.round(outputChars / 4)` into named `const` variables before constructing the `TokenUsage` object. Set `totalTokens` to `inputTokens + outputTokens` (sum of the already-rounded variables) instead of re-calling `Math.round` twice.
2. `packages/nr-ai-mcp-server/src/metrics/cost-tracker.test.ts` — Add a test: call `recordEstimatedTokens` with `inputChars = 1, outputChars = 1` (each rounds to 0 independently, but together `Math.round(2/4) = 1`). Assert `totalTokens === inputTokens + outputTokens` (i.e., the components and total are always consistent).

---

### ✅ 109. Session-average `EfficiencyScore` uses last task's timestamp instead of computation time

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts:140`

```typescript
return {
  score: ...,
  components: { ... },
  taskId: 'session-average',
  timestamp: this.scores[this.scores.length - 1].timestamp,  // ← last task's end time, not now
};
```

The `getSessionAverage()` method returns an aggregate score whose `timestamp` is set to the last scored task's end time. If the session has been running for hours since the last completed task, the session average appears time-anchored to that old task. Dashboard queries that filter by timestamp (e.g., "efficiency in the last 5 minutes") will miss the session average.

**Impact:** Session-average metrics may be attributed to the wrong time window in NR dashboards, making them invisible in recent-data queries.

**Fix:**
```typescript
timestamp: Date.now(),
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts` (`getSessionAverage()`, line 140) — Replace `this.scores[this.scores.length - 1].timestamp` with `Date.now()` so the session-average metric is always time-anchored to when it was computed, not to the last task's end time.
2. `packages/nr-ai-mcp-server/src/metrics/efficiency-score.test.ts` — Add a test: score one task, wait a tick (or advance fake timers), call `getSessionAverage()`, and assert `average.timestamp >= task.timestamp` (i.e., the session average is not anchored to the old task's timestamp).

---

### ✅ 110. Cost breakdown response omits cache token counts

**Severity: LOW**
**File:** `packages/nr-ai-mcp-server/src/tools/cost-tools.ts:126-130`

```typescript
tokens: {
  input: metrics.totalInputTokens,
  output: metrics.totalOutputTokens,
  thinking: metrics.totalThinkingTokens,
  // ← cache_read and cache_creation absent
},
```

`CostTracker` tracks `totalCacheReadTokens` and `totalCacheCreationTokens` separately, and they contribute to the session cost via `calculateCost()`. The `handleGetCostBreakdown` response exposes three of five token categories. Users cannot verify their cache token usage or understand why their reported cost differs from what they expect based on input+output alone.

**Impact:** Cost breakdowns are incomplete for sessions with prompt caching. Users cannot audit cache costs through the MCP tool.

**Fix:**
```typescript
tokens: {
  input: metrics.totalInputTokens,
  output: metrics.totalOutputTokens,
  thinking: metrics.totalThinkingTokens,
  cache_read: metrics.totalCacheReadTokens,
  cache_creation: metrics.totalCacheCreationTokens,
},
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/tools/cost-tools.ts` (lines 126–130) — Add `cache_read: metrics.totalCacheReadTokens` and `cache_creation: metrics.totalCacheCreationTokens` to the `tokens` object in `handleGetCostBreakdown`.
2. `packages/nr-ai-mcp-server/src/tools/cost-tools.test.ts` — Add a test: provide a `CostTracker` with recorded cache tokens, call `handleGetCostBreakdown`, and assert the JSON response includes `tokens.cache_read` and `tokens.cache_creation` with the expected values.

---

## Round 7 Recommendation

**Fix before wider sharing:**
- **#99** (`res.end()` without `res.writeHead()`) — upstream errors silently appear as 200 OK to proxy clients.
- **#100** (`requeueBatch` drops failed batch) — log delivery failures compound: the batch that failed is the first dropped on overflow, making retries ineffective.
- **#101** (`error_rate` uses test pass rate) — the platform comparison error_rate metric is semantically wrong; all platforms show artificially low error rates when developers don't run tests.

**Fix before production use:**
- **#102** (negative `generationDurationMs`) — corrupts a core timing metric for streaming sessions with thinking.
- **#103** (`percentChange` zero baseline) — trend reports suppress all week-over-week changes from zero baselines, making the trend feature useless for new adopters.
- **#104** ("Learning" classification) — misclassified developers receive wrong coaching recommendations.
- **#105** (empty effectSizes → "significant") — phantom significance verdicts on CLAUDE.md impact when session count is too low.
- **#106** (unstable `listSessions` sort) — non-deterministic session ordering affects trend analysis and weekly summaries.

**Low priority:**
- **#107–110** — contract violations and incomplete data that have minimal user-visible impact in typical use.

---

## Cumulative Statistics

| Round | Date | Critical | High | Medium | Low | Total |
|-------|------|----------|------|--------|-----|-------|
| 1 | 2026-04-20 | 0 | 4 | 6 | 2 | 12 |
| 2 | 2026-04-21 | 0 | 2 | 14 | 4 | 20 |
| 3 | 2026-04-21 | 3 | 10 | 19 | 3 | 35 |
| 4 | 2026-04-21 | 0 | 3 | 4 | 3 | 10 |
| 5 | 2026-04-22 | 1 | 4 | 4 | 0 | 9 |
| 6 | 2026-04-22 | 0 | 2 | 6 | 1 | 9 |
| 7 | 2026-04-22 | 0 | 3 | 5 | 4 | 12 |
| **Total** | | **4** | **28** | **58** | **17** | **107** |
