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
