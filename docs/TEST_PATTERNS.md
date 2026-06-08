# NR AI Coding Observability — Test Patterns

This document covers the testing conventions, infrastructure, and patterns used in this repo. Read this before writing your first test.

---

## Test Infrastructure

### Jest configuration

A single flat `jest.config.ts` at the repo root governs every test. There are no per-package configs and no base config to extend.

Key settings:

| Setting                  | Value                                                           | Why                                                                    |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `preset`                 | `ts-jest/presets/default-esm`                                   | ESM modules with TypeScript                                            |
| `testEnvironment`        | `node`                                                          | No browser DOM needed                                                  |
| `testMatch`              | `['<rootDir>/src/**/*.test.ts', '<rootDir>/test/**/*.test.ts']` | Co-located unit tests + dedicated `test/` folder                       |
| `moduleNameMapper`       | `'^(\\.{1,2}/.*)\\.js$': '$1'`                                  | Strips `.js` extensions in TS imports for ts-jest                      |
| `extensionsToTreatAsEsm` | `['.ts']`                                                       | Tells Jest to treat `.ts` as ESM                                       |
| `testTimeout`            | `15_000`                                                        | 15s default per test                                                   |
| `maxWorkers`             | `1`                                                             | Prevents deadlocks in stdio integration tests                          |
| `forceExit`              | `true`                                                          | Ensures Jest terminates after harvest schedulers / proxies are stopped |
| `tsconfig` (transform)   | `tsconfig.test.json`                                            | Loose TS settings for test compilation                                 |

`src/shared/` is imported relatively (`from '../shared/index.js'`), so no special module resolution is required.

### Running tests

```bash
npm test                                         # Entire Jest suite
npx jest -- src/shared/                          # All tests under one directory
npx jest -- src/metrics/cost-tracker.test.ts     # One file
npx jest -- --testNamePattern="re-queues"        # Tests matching a name pattern
```

---

## Web Tests (Vitest)

The web dashboard in `src/web/` uses a **separate test runner**: [Vitest](https://vitest.dev/), not Jest. These are the only tests that use React components, browser APIs, or `.tsx` files.

```bash
npm run test:web    # Run the Vitest suite
```

Vitest is configured via the `root: resolve(__dirname, 'src/web')` setting in `vite.config.ts`, so it discovers tests only within `src/web/`.

### Key differences from Jest tests

| Concern        | Jest (`src/**/*.test.ts`) | Vitest (`src/web/**/*.test.tsx`)  |
| -------------- | ------------------------- | --------------------------------- |
| File extension | `.test.ts`                | `.test.tsx`                       |
| Import globals | `from '@jest/globals'`    | vitest globals (no import needed) |
| Spy/mock       | `jest.spyOn`, `jest.fn`   | `vi.spyOn`, `vi.fn`               |
| Run command    | `npm test`                | `npm run test:web`                |

**Important:** Web test files must use `.test.tsx`, not `.test.ts`. Jest picks up `.test.ts` files under `src/web/` and fails on Vitest imports; the `.tsx` extension is what routes them to Vitest instead.

Web tests follow the same factory-function and spy patterns as Jest tests — just with `vi.*` instead of `jest.*`.

---

## Global Test Setup

Nearly every test file follows this setup pattern:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});
```

**Why mock stderr?** All modules use `createLogger()`, which writes structured JSON to stderr. Without mocking, test output is flooded with logger lines. The spy also allows asserting on log output when needed:

```typescript
const logOutput = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
expect(logOutput).toContain('re-queuing batch for retry');
```

---

## Factory Functions

Every test file defines `make*` factory functions that produce valid default objects with optional `Partial<T>` overrides. This is the most important pattern in the test suite.

### ToolCallRecord factory

The most common factory — used by all metric tracker and tool handler tests:

```typescript
function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}
```

Usage — only specify the fields relevant to what you're testing:

```typescript
makeRecord({ toolName: 'Edit', filePath: '/a.ts' });
makeRecord({ toolName: 'Bash', success: false, errorType: 'timeout' });
makeRecord({ durationMs: 200 });
```

### HookEvent factories

Event processor tests define separate factories for pre and post events:

```typescript
function makePreEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'pre',
    tool: 'Read',
    timestamp: 1000,
    inputSize: 42,
    inputHash: 'abc123def456abcd',
    toolUseId: 'toolu_001',
    sessionId: 'sess-001',
    ...overrides,
  };
}

function makePostEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    mode: 'post',
    tool: 'Read',
    timestamp: 1050,
    outputSize: 1024,
    success: true,
    toolUseId: 'toolu_001',
    sessionId: 'sess-001',
    ...overrides,
  };
}
```

### SessionSummary factory

Cross-session tool tests use a full session summary factory with many fields:

```typescript
function makeSummary(overrides?: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId: `sess-${now}-${Math.random().toString(36).slice(2)}`,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 10,
    developer: 'alice',
    // ... many more fields with sensible defaults
    ...overrides,
  };
}
```

### AiCodingTask factory

Efficiency scorer tests build task objects:

```typescript
function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1000,
    endTime: 61000,
    durationMs: 60000,
    toolCallCount: 10,
    // ... sensible defaults
    ...overrides,
  };
}
```

### ProxyToolCallRecord factory

NR ingest tests for proxy mode extend `makeRecord` with proxy-specific fields:

```typescript
function makeProxyRecord(overrides?: Partial<ProxyToolCallRecord>): ProxyToolCallRecord {
  return { ...makeRecord(), serverName: 'test-server', upstreamLatencyMs: 10, ...overrides };
}
```

### Guidelines for factory functions

- Name them `make*` — `makeRecord`, `makeEvent`, `makeSession`, `makeTask`, etc.
- Provide sensible defaults for all required fields
- Accept `Partial<T>` with spread to allow selective override
- Keep them at module scope (above `describe` blocks), not inside them
- If a domain has distinct subtypes (pre/post events, success/failure), create separate factories

---

## Patterns by Category

### Metric tracker tests

All metric trackers in `src/metrics/` follow the same test structure: create a tracker, feed it records, read out metrics, assert.

```typescript
describe('SessionTracker', () => {
  it('tracks correct toolCallCountByTool for mixed tools', () => {
    const tracker = new SessionTracker('test-session');

    for (let i = 0; i < 5; i++) tracker.recordToolCall(makeRecord({ toolName: 'Read' }));
    for (let i = 0; i < 3; i++) tracker.recordToolCall(makeRecord({ toolName: 'Edit' }));

    const metrics = tracker.getMetrics();
    expect(metrics.toolCallCount).toBe(8);
    expect(metrics.toolCallCountByTool).toEqual({ Read: 5, Edit: 3 });
  });
});
```

**Pattern:** `new Tracker()` → `tracker.recordToolCall(makeRecord(...))` (repeat) → `tracker.getMetrics()` → assertions.

For trackers that detect patterns over sequences (like `AntiPatternDetector`), build an array of records and pass them all at once:

```typescript
const calls: ToolCallRecord[] = [
  makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
  makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
  makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
  makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
  makeRecord({ toolName: 'Edit', filePath: '/a.ts' }),
  makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
];

const result = detector.analyze(calls);
const thrashing = result.patterns.filter((p) => p.type === 'thrashing');
expect(thrashing).toHaveLength(1);
```

### MCP tool handler tests

Tool handlers are pure functions that take tracker instances and return MCP-formatted responses. Tests create real tracker instances, feed them data, then call the handler:

```typescript
describe('handleGetSessionStats()', () => {
  it('returns correct JSON structure after recording 10 tool calls', () => {
    const tracker = new SessionTracker('stats-session');

    for (let i = 0; i < 5; i++) tracker.recordToolCall(makeRecord({ toolName: 'Read' }));
    for (let i = 0; i < 3; i++) tracker.recordToolCall(makeRecord({ toolName: 'Edit' }));

    const result = handleGetSessionStats(tracker);
    const stats = JSON.parse(result.content[0].text);

    expect(stats.session_id).toBe('stats-session');
    expect(stats.tool_calls).toBe(8);
  });
});
```

**Pattern:** Create real trackers → feed data → call handler → `JSON.parse(result.content[0].text)` → assert fields.

### Storage tests (temp directory pattern)

Tests that touch the filesystem create a unique temp directory per test and clean it up afterward:

```typescript
let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(
    tmpdir(),
    `nr-localstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

The directory name includes both `Date.now()` and a random suffix to guarantee uniqueness across parallel runs and rapid re-runs. Tests call `mkdirSync(tmpDir, { recursive: true })` or `store.initialize()` at the start of each test case.

```typescript
it('round-trips a single event', () => {
  const store = new LocalStore(tmpDir);
  mkdirSync(tmpDir, { recursive: true });

  const event = makeEvent({ tool: 'Write' });
  store.appendToBuffer(event);

  const drained = store.drainBuffer();
  expect(drained).toHaveLength(1);
  expect(drained[0]).toEqual(event);
});
```

### Timer-dependent tests

Use `jest.useFakeTimers()` when testing anything that relies on `setInterval`, `setTimeout`, or `Date.now()`. The `HarvestScheduler` tests are the primary example:

```typescript
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
});

it('fires events harvest at 5s intervals', async () => {
  const { scheduler, sendEventsFn } = makeScheduler();
  scheduler.addEvent({ eventType: 'Test', value: 1 });
  scheduler.start();

  await jest.advanceTimersByTimeAsync(5_000);
  expect(sendEventsFn).toHaveBeenCalledTimes(1);

  await scheduler.stop();
});
```

**Important:** Use `jest.advanceTimersByTimeAsync()` (not the sync version) when the code under test uses `async/await` or Promises. Always call `scheduler.stop()` or equivalent cleanup before the test ends.

### Transport / HTTP tests

Transport tests mock `global.fetch` via a spy to simulate HTTP responses:

```typescript
let fetchSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});
```

Tests then configure mock responses and verify request properties:

```typescript
mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
const result = await sendWithRetry(baseOptions());
expect(result.success).toBe(true);
expect(mockFetch).toHaveBeenCalledTimes(1);
```

### Event processor tests

These combine the temp directory pattern (for `LocalStore`) with pre/post event factories and a mock callback:

```typescript
let records: ToolCallRecord[];
let onRecord: jest.Mock<(record: ToolCallRecord) => void>;

beforeEach(() => {
  records = [];
  onRecord = jest.fn((record: ToolCallRecord) => {
    records.push(record);
  });
});

it('pairs pre + post events into a ToolCallRecord', () => {
  const processor = new HookEventProcessor({ store, onRecord });
  processor.processEvents([makePreEvent(), makePostEvent()]);

  expect(records).toHaveLength(1);
  expect(records[0].toolName).toBe('Read');
  expect(records[0].durationMs).toBe(50);
});
```

---

## Describe / Test Structure

### Numbered section comments

Test files use numbered section comments to organize test groups:

```typescript
// ---------------------------------------------------------------------------
// 1. Events harvest fires at 5s, metrics at 60s
// ---------------------------------------------------------------------------
it('fires events harvest at 5s intervals and metrics at 60s', async () => { ... });

// ---------------------------------------------------------------------------
// 2. stop() triggers final flush
// ---------------------------------------------------------------------------
it('stop triggers final flush of both buffers', async () => { ... });
```

### Nested describes

Use nested `describe` blocks when a module has multiple distinct behaviors:

```typescript
describe('SessionTracker', () => {
  describe('recordToolCall() — tool counts', () => { ... });
  describe('duration stats', () => { ... });
  describe('file tracking', () => { ... });
  describe('reset()', () => { ... });
});
```

### Test naming

Write test names as complete sentences that describe the expected behavior:

```
'detects Edit→test FAIL cycle repeated 3 times'
'does not detect when test passes'
'resets cycle count after a passing test'
'computes min, max, sum, count, and p95 correctly'
'handles records with null durationMs gracefully'
'combines re-queued events with new events on next harvest'
'concurrent stop() calls share the same flush promise'
```

---

## Mocking Strategy

### What we mock

| What                             | How                                | Why                                                      |
| -------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `process.stderr.write`           | `jest.spyOn`                       | Suppress logger output; optionally assert on log content |
| `globalThis.fetch`               | `jest.fn`                          | Simulate HTTP responses without network                  |
| `sendEventsFn` / `sendMetricsFn` | `jest.fn` injected via constructor | Control harvest send behavior                            |
| `onRecord` callback              | `jest.fn`                          | Capture emitted `ToolCallRecord` objects                 |

### What we don't mock

- **Metric trackers in tool handler tests** — we use real tracker instances, not mocks. This validates the full path from data in to tool response out.
- **`LocalStore` in event processor tests** — we create a real store with a temp directory. This catches serialization/deserialization bugs.
- **`MetricAggregator` in harvest tests** — real aggregator, real buckets.

The philosophy: mock at system boundaries (network, stdio), use real implementations for internal components.

---

## Exemplary Test Files

These files demonstrate the patterns well and serve as templates for new tests:

| File                                           | Demonstrates                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/shared/harvest/harvest-scheduler.test.ts` | Fake timers, mock send functions, retry/requeue, concurrent stop, atomic snapshot |
| `src/metrics/session-tracker.test.ts`          | Metric tracker pattern: record → getMetrics → assert                              |
| `src/metrics/anti-patterns.test.ts`            | Sequence-based detection: build record arrays, analyze, filter results            |
| `src/metrics/efficiency-score.test.ts`         | Task factory, component scoring, boundary conditions                              |
| `src/hooks/event-processor.test.ts`            | Pre/post event pairing, temp directory, mock callback                             |
| `src/storage/local-store.test.ts`              | Filesystem tests with temp directory cleanup, edge cases                          |
| `src/tools/session-stats.test.ts`              | Tool handler pattern: real trackers → handler → JSON.parse                        |
| `src/tools/cross-session-tools.test.ts`        | Cross-session tools with SessionStore, temp directory, rich factories             |
| `src/shared/transport/http-client.test.ts`     | fetch mocking, gzip verification, region detection, retry behavior                |
| `src/security/audit-trail.test.ts`             | Security classification, regex pattern testing, false positive/negative coverage  |
| `src/transport/nr-ingest.test.ts`              | Proxy event builders, session trace ID propagation, `makeProxyRecord` factory     |

---

## Writing a New Test

1. Create `your-module.test.ts` alongside `your-module.ts`
2. Add the stderr spy in `beforeEach`/`afterEach`
3. Write a `make*` factory for your primary data type
4. If your module touches the filesystem, use the temp directory pattern
5. If your module uses timers, use `jest.useFakeTimers()`
6. Structure with `describe` blocks for each behavior group
7. Name tests as complete sentences describing expected behavior
8. Run with `npx jest -- src/path/to/your-module.test.ts`
