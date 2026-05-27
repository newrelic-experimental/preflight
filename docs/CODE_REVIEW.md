# Code Review — `src/`

**Date:** 2026-05-21
**Reviewer:** Claude Opus 4.7 (with parallel Explore-agent investigation)
**Scope:** Everything under `src/`, including `src/shared/` (read-only mirror — findings flagged for upstream) and all `*.test.ts` files
**Branch:** `chris/src-code-review`

---

## Methodology

Five parallel Explore agents reviewed the codebase along orthogonal axes:

- **Agent A — Security:** input validation, redaction, file permissions, SSRF, command injection, env-var leakage, process safety, audit-trail gaps, high-security-mode bypass paths
- **Agent B — Lifecycle / resource leaks:** timer leaks, listener leaks, unclosed handles/streams, harvester race conditions, shutdown ordering, stdio buffer growth, unbounded data structures
- **Agent C — Correctness (metrics, hooks, storage):** logic bugs, off-by-one, divide-by-zero, time-window math, anti-pattern detection edge cases, atomicity, write-then-read races
- **Agent D — Correctness (transport, proxy, tracing, server, config):** retry logic, span lifecycle, MCP server behaviour, NR ingest correctness, configuration loading
- **Agent E — Type safety, boundary validation, tests:** loose `unknown`/`any`, missing zod validation, optional-chain holes, MCP tool input/output schemas, test reliability

Findings are de-duplicated where multiple agents flagged the same issue. Each finding records file:line, category, severity, the issue, an impact assessment, and a suggested fix.

---

## Severity legend

| Severity | Meaning |
|---|---|
| **Critical** | Active security vulnerability, data corruption risk, or production crash on common inputs |
| **High** | Latent bug that will fire under realistic conditions; or a security/correctness gap that meaningfully degrades the product |
| **Medium** | Bug under uncommon conditions, or a correctness/clarity issue that should be fixed before launch |
| **Low** | Nit, minor inefficiency, or future-proofing concern; not blocking |
| **Info** | Observation or suggestion; no defect required |

---

## Categories

| Code | Category |
|---|---|
| **SEC** | Security |
| **LIFE** | Lifecycle / resource management |
| **CORR** | Correctness / logic |
| **TYPE** | Type safety / API contracts |
| **TEST** | Test reliability or coverage gap |
| **PERF** | Performance |
| **DOC** | Documentation mismatch with implementation |

---

## Summary

**Total findings:** 140 across two review passes, each verified individually against source.

| Verification status | Pass 1 (F-001 to F-076) | Pass 2 (F-077 to F-140) | **Total** |
|---|---|---|---|
| ✅ Confirmed | 56 | 62 | **118** |
| ❌ False positive | 18 | 1 | **19** |
| ⚠️ Partial (true but narrower scope or weaker impact) | 2 | 1 | **3** |

**Pass 1** covered the bulk of `src/` across security, lifecycle, correctness, type-safety, and tests. **Pass 2** covered the previously-deferred areas: 6 metric trackers (`trend-analyzer`, `claudemd-tracker`, `prompt-feedback`, `cost-forecast`, `proxy-metrics`, `task-completion-tracker`), `install-helper.ts`, OTLP receiver edge cases, redaction-pattern coverage, IPv6 / DNS-rebind SSRF, and test coverage gaps.

**False positives (do not act on):** F-006, F-007, F-018, F-023, F-029, F-034, F-038, F-039, F-044, F-048, F-053, F-057, F-059, F-065, F-067, F-069, F-071, F-074, F-086. Each carries a `**Verification:**` block.

**Partials (act on with reduced urgency):** F-014, F-055, F-081.

**Highest-severity new findings (Pass 2):**

- **Critical** — F-095 (OTLP receiver no body-size limit → trivial OOM); F-096 (OTLP receiver binds to `0.0.0.0` by default)
- **High (security)** — F-097 (no slow-loris timeout); F-098 (no gzip handling); F-099 (no rate limiting); F-107 / F-108 / F-111 / F-112 (missing redaction patterns: `ghs_`, Stripe live keys, DB connection strings, basic-auth URLs); F-117 / F-118 / F-119 (IPv6 SSRF gaps); F-120 (DNS rebinding window)
- **High (correctness)** — F-081 (end-of-week math wrong on every non-Sunday day); F-084 (task-completion-tracker missing `recordToolCall`); F-098 (gzip not decompressed)
- **Critical (test gaps)** — F-125 (no end-to-end redaction test); F-126 (no test that high-security mode scrubs content)

Two earlier Critical-rated findings from the initial agent reports were also rejected before being numbered (CostTracker.reset and persistSession not awaited) — see "Verification notes" at the bottom of the document.

---

## Findings

*Findings are appended below in order of (severity, category). Each finding follows the format:*

```
### [F-NNN] Short title — Severity (Category)
**Location:** path/to/file.ts:line[-line]
**Issue:** what's wrong
**Impact:** what can go wrong, and under what conditions
**Suggested fix:** how to address it
```

*Findings begin below.*

> **Verification:** findings flagged ✅ have been spot-checked against the actual source by the reviewer. Findings flagged 🔍 are agent-reported but not independently verified — they should be re-checked before being treated as confirmed bugs. Per the saved feedback memory `feedback_subagent_audit_verification`, audit-agent claims sometimes misidentify code as broken; treat agent-reported findings as hypotheses to verify, not facts.

---

## High severity

### ~~[F-001] NRQL injection via `teamId` in cross-session-tools — High (SEC) ✅~~
~~**Location:** `src/tools/cross-session-tools.ts:619, 653, 658, 663`~~
~~**Issue:** `teamId` is sanitised by `.replace(/'/g, "\\'")` and then interpolated into NRQL string literals (`team_id = '${safeTeamId}'`). Single-quote escaping alone is insufficient: backslashes are not escaped, so `\\' OR '1'='1` bypasses the escape and injects arbitrary NRQL operators.~~
~~**Impact:** A caller controlling `teamId` (config file, env var, or any future surface that exposes it) can break out of the WHERE clause and read arbitrary NR data the account has access to. Even if the current threat model treats `teamId` as trusted, the pattern is a footgun for future surfaces.~~
~~**Suggested fix:** Pass `teamId` as a NerdGraph variable rather than interpolating into the NRQL string, e.g. add `$teamId: String!` to the GraphQL query and reference it as `WHERE team_id = $teamId`. Alternatively, validate `teamId` against a strict allowlist regex (`/^[a-zA-Z0-9_-]+$/`) at config load.~~

~~**Implementation steps for Haiku:**

1. Open `src/tools/cross-session-tools.ts`.
2. Locate line 619: `const safeTeamId = options.teamId.replace(/'/g, "\\'");`
3. Replace that single line with a strict allowlist validator:
   ```typescript
   if (!/^[a-zA-Z0-9_-]+$/.test(options.teamId)) {
     return {
       content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid teamId format. Allowed characters: a-z, A-Z, 0-9, underscore, hyphen.' }) }],
       isError: true,
     };
   }
   const safeTeamId = options.teamId;
   ```
4. Build: `npm run build`. Confirm no TypeScript errors.
5. Open `src/tools/cross-session-tools.test.ts` (create if it doesn't exist).
6. Add a new test case `it('rejects teamId with special characters')` that calls the team-summary tool with `teamId: "team' OR '1'='1"` and asserts the result contains `isError: true`.
7. Add a positive test case `it('accepts teamId with valid characters')` with `teamId: "platform-team_123"` and asserts no error.
8. Run: `npx jest -- src/tools/cross-session-tools.test.ts`. All tests must pass.
9. Run: `npm run lint`. No new warnings.
10. Verify: grep for any remaining `\\'` escape pattern in the file — should now be zero matches.~~

---

### ~~[F-002] World-readable directory creation in `install/cli.ts` — High (SEC) ✅~~
~~**Location:** `src/install/cli.ts:44`~~
~~**Issue:** `mkdirSync(dir, { recursive: true })` omits `mode`, so the directory is created with the default umask (typically `0o755` — world-readable). CLAUDE.md mandates `0o700` for storage directories.~~
~~**Impact:** Per-user config directories under `~/.claude/` and `~/.mcp.json` parents become readable by other users on shared systems. These directories will hold files containing API keys, account IDs, and developer identifiers — a direct credential-disclosure risk on multi-user hosts.~~
~~**Suggested fix:** `mkdirSync(dir, { recursive: true, mode: 0o700 })`. Audit every other `mkdirSync` call in `src/` for the same omission.~~

~~**Implementation steps for Haiku:**

1. Open `src/install/cli.ts`.
2. Locate line 44: `mkdirSync(dir, { recursive: true });`
3. Replace with: `mkdirSync(dir, { recursive: true, mode: 0o700 });`
4. Build: `npm run build`. Must succeed.
5. Run: `npx jest -- src/install` to confirm install tests still pass.
6. Run: `grep -rn "mkdirSync" src/ | grep -v ".test.ts" | grep -v "mode:"` — note any other lines that need the same fix (these are F-004 and F-005 below).
7. Run: `npm run lint`. No new warnings.~~

---

### ~~[F-003] World-readable file creation in `install/cli.ts` — High (SEC) ✅~~
~~**Location:** `src/install/cli.ts:46`~~
~~**Issue:** `writeFileSync(path, ...)` omits the `mode` option, so the resulting file inherits the umask — typically `0o644` (world-readable). CLAUDE.md mandates `0o600` for storage files.~~
~~**Impact:** Same as F-002 — credential disclosure on shared hosts. Compounds with F-002 because both the directory and its contents are world-readable.~~
~~**Suggested fix:** `writeFileSync(path, content, { mode: 0o600 })`. Audit every `writeFileSync` for missing mode.~~

~~**Implementation steps for Haiku:**

1. Open `src/install/cli.ts`.
2. Locate line 46: the `writeFileSync(path, ...)` call (likely `writeFileSync(path, JSON.stringify(data, null, 2) + '\n');`).
3. Add `, { mode: 0o600 }` as the last argument before the closing parenthesis. The result should be: `writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });`
4. Build: `npm run build`. Must succeed.
5. Run: `npx jest -- src/install`.
6. Run: `grep -rn "writeFileSync" src/ | grep -v ".test.ts" | grep -v "mode:"` to find any other writes missing the `mode` option. For each one, add `{ mode: 0o600 }` similarly.
7. Run: `npm run lint`.~~

---

### ~~[F-004] World-readable directory creation in `weekly-summary.ts` — High (SEC) ✅~~
~~**Location:** `src/storage/weekly-summary.ts:132`~~
~~**Issue:** Same pattern as F-002 — `mkdirSync(this.summariesDir, { recursive: true })` without `mode`.~~
~~**Impact:** Weekly summary files contain per-developer cost and efficiency metrics. World-readable on shared hosts.~~
~~**Suggested fix:** Add `mode: 0o700`.~~

~~**Implementation steps for Haiku:**

1. Open `src/storage/weekly-summary.ts`.
2. Locate line 132: `mkdirSync(this.summariesDir, { recursive: true });`
3. Replace with: `mkdirSync(this.summariesDir, { recursive: true, mode: 0o700 });`
4. While in this file, also audit any `writeFileSync` calls. For each that writes summary JSON to disk, add `{ mode: 0o600 }` as the last argument.
5. Build: `npm run build`.
6. Run: `npx jest -- src/storage/weekly-summary.test.ts`.
7. Run: `npm run lint`.~~

---

### ~~[F-005] World-readable directory creation in `session-store.ts` — High (SEC) ✅~~
~~**Location:** `src/storage/session-store.ts:100`~~
~~**Issue:** Same pattern as F-002 — `mkdirSync(this.sessionsDir, { recursive: true })` without `mode`.~~
~~**Impact:** Session JSON files contain detailed tool-call telemetry, file paths read/modified, and developer identity. World-readable on shared hosts.~~
~~**Suggested fix:** Add `mode: 0o700`.~~

~~**Implementation steps for Haiku:**

1. Open `src/storage/session-store.ts`.
2. Locate line 100: `mkdirSync(this.sessionsDir, { recursive: true });`
3. Replace with: `mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });`
4. Find the `writeFileSync` call at line ~110 (the one writing the session JSON file). Add `{ mode: 0o600 }` as the third argument: `writeFileSync(filepath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });`
5. Build: `npm run build`.
6. Run: `npx jest -- src/storage/session-store.test.ts`.
7. Run: `npm run lint`.~~

---

### [F-006] Tool-specific fields not redacted in NR ingest serializer — High (SEC) ❌
**Location:** `src/transport/nr-ingest.ts:141-147`
**Issue:** `toolCallToNrEvent()` copies tool-specific fields (`filePath`, `command`, `agentDescription`, `pattern`) directly into the NR event without applying `redactSensitive()`. Hook-level redaction is the only defence.
**Impact:** If hook-level redaction is misconfigured, bypassed, or the upstream parser returns an unredacted value, secrets reach the NR Events API. Defence-in-depth is missing — the serializer should enforce redaction independently.
**Suggested fix:** Apply `redactSensitive()` to all string-valued tool-specific fields inside `toolCallToNrEvent()` regardless of upstream redaction.

**Verification:** ❌ FALSE POSITIVE — Tool-specific fields ARE filtered through `STANDARD_KEYS` (`nr-ingest.ts:142-147`); raw input fields cannot pass through.

---

### [F-007] Audit-trail security alert description includes unredacted command — High (SEC) ❌
**Location:** `src/security/audit-trail.ts:156`
**Issue:** The audit *record* applies `redactSensitive()` to the command field, but the security-alert description constructed earlier uses the unredacted command verbatim.
**Impact:** Destructive command alerts (e.g. `rm -rf $SECRET_DIR`) leak the unredacted command into logs and any downstream alert sink. Defeats the purpose of having redaction in the audit trail.
**Suggested fix:** Apply `redactSensitive()` once at the top of the alert path, before constructing both the alert description and the audit record. Remove the duplicated/inconsistent redaction logic.

**Verification:** ❌ FALSE POSITIVE — `redactSensitive(command)` IS called in the alert description path; the agent's evidence corrects its own label.

---

### ~~[F-008] `SIGTERM` listener uses `process.on()` while `beforeExit` uses `process.once()` — High (LIFE) ✅~~
~~**Location:** `src/hooks/event-processor.ts:77-78`~~
~~**Issue:** Inconsistent listener registration: line 77 uses `process.once('beforeExit', ...)` but line 78 uses `process.on('SIGTERM', ...)`. If `start()` is called twice without an intervening `stop()` (e.g. test reinit), SIGTERM handlers accumulate and a single signal fires `stop()` multiple times in succession.~~
~~**Impact:** Tests reinitialising the processor can leak listeners. Stop() does call `removeListener` (line 96), but only the listener it registered last — earlier accumulations stay.~~
~~**Suggested fix:** Change line 78 to `process.once('SIGTERM', this.boundSigterm)` to match line 77, and ensure `start()` is idempotent (early-return when already running, which it is — but make the listener registration symmetric).~~

~~**Implementation steps for Haiku:**

1. Open `src/hooks/event-processor.ts`.
2. Locate line 78: `process.on('SIGTERM', this.boundSigterm);`
3. Replace with: `process.once('SIGTERM', this.boundSigterm);` (just change `on` to `once`).
4. Verify lines 95-96 in the `stop()` method still call `process.removeListener('SIGTERM', this.boundSigterm);` — this is now harmless if the listener already auto-removed, but keep it for the not-yet-fired case.
5. Build: `npm run build`. Must succeed.
6. Run: `npx jest -- src/hooks/event-processor.test.ts`.
7. Add a regression test `it('does not accumulate SIGTERM handlers across start/stop cycles')` that calls `start()` → `stop()` → `start()` → `stop()` and asserts `process.listenerCount('SIGTERM')` is unchanged compared to before the first `start()`.
8. Run: `npm run lint`.~~

---

### ~~[F-009] `process.stdin.on('end', ...)` listener never removed — High (LIFE) ✅~~
~~**Location:** `src/index.ts:407-410`~~
~~**Issue:** A listener is attached to `process.stdin.on('end', ...)` with no corresponding `removeListener`. In long-lived processes that restart the MCP server (tests, supervisors), listeners accumulate.~~
~~**Impact:** Multiple stdin-end handlers fire on a single end event, calling `void shutdown()` repeatedly and racing the cleanup paths against each other.~~
~~**Suggested fix:** Save the listener as a named function and call `process.stdin.removeListener('end', stdinEndListener)` from the shutdown handler. Or use `process.stdin.once('end', ...)`.~~

~~**Implementation steps for Haiku:**

1. Open `src/index.ts`.
2. Locate line 407 (or near it): `process.stdin.on('end', () => { void shutdown(); });`
3. Replace with `process.stdin.once('end', () => { void shutdown(); });` (change `on` to `once`).
4. Build: `npm run build`. Must succeed.
5. Run: `npx jest`. All tests must pass.
6. Run: `npm run lint`.~~

---

### ~~[F-010] HookEventProcessor pending-map LRU eviction is not FIFO — High (LIFE) ✅~~
~~**Location:** `src/hooks/event-processor.ts:160-165`~~
~~**Issue:** When `pending.size` exceeds `maxPendingEvents`, the oldest *map iteration order* entry is dropped. Map iteration is insertion order in JS, but the LRU semantic isn't guaranteed if `set()` is used to refresh existing keys. Combined with the timestamp+counter fallback key (line 175), evictions can drop pre-events that have legitimate post-events still arriving.~~
~~**Impact:** Under burst load with delayed post events, tool calls are silently dropped. No log of which tool was evicted; debugging is hard.~~
~~**Suggested fix:** Use a proper FIFO queue (insertion-only, no refresh) or scope eviction to entries past `orphanTimeoutMs`. Log evictions with tool name.~~

~~**Implementation steps for Haiku:**

1. Open `src/hooks/event-processor.ts`.
2. Locate the eviction block at lines 160-165 (the code that runs when `this.pending.size > this.maxPendingEvents`).
3. Modify the eviction logic: instead of just dropping the first entry, find the *oldest* entry (by `event.timestamp`) past `orphanTimeoutMs`. If none are old enough, drop the oldest by insertion order, but log a warning.
4. Concretely, replace the eviction block with:
   ```typescript
   if (this.pending.size > this.maxPendingEvents) {
     // Prefer evicting events that are already past the orphan timeout
     const now = Date.now();
     let evictedKey: string | undefined;
     for (const [key, event] of this.pending) {
       if (now - event.timestamp >= this.orphanTimeoutMs) {
         evictedKey = key;
         break;
       }
     }
     if (evictedKey === undefined) {
       evictedKey = this.pending.keys().next().value;
       this.logger.warn('Evicting non-orphan pre-event due to capacity overflow', { evictedKey });
     }
     if (evictedKey) {
       this.pending.delete(evictedKey);
     }
   }
   ```
5. Build: `npm run build`.
6. Run: `npx jest -- src/hooks/event-processor.test.ts`.
7. Add a regression test `it('evicts orphans before non-orphans when at capacity')`: pre-populate `this.pending` with one fresh entry and one >`orphanTimeoutMs`-old entry, push one more entry, assert the old entry was evicted.
8. Run: `npm run lint`.~~

---

### ~~[F-011] Percentile calculation inconsistency between `LatencyTracker` and `SessionTracker` — High (CORR) ✅~~
~~**Location:** `src/metrics/latency-tracker.ts:74-76` vs `src/metrics/session-tracker.ts:60`~~
~~**Issue:** Two different formulas:
- `LatencyTracker`: `Math.floor(count * 0.95)`
- `SessionTracker.computeP95`: `Math.floor((sorted.length - 1) * 0.95)`
With 100 samples, the first picks index 95, the second picks index 94. The two trackers report different p95/p99 numbers for the same input.~~
~~**Impact:** Latency dashboards and alerts disagree depending on which tracker emitted the metric. Hard-to-debug discrepancy in p95/p99 displays.~~
~~**Suggested fix:** Standardise on `Math.floor((count - 1) * percentile)` in both places (this is the "nearest-rank" convention). Add a shared helper `computePercentile(sorted, p)` in `src/shared/` or `src/metrics/` and have both trackers use it.~~

~~**Implementation steps for Haiku:**

1. Create a new file `src/metrics/percentile.ts` with this content:
   ```typescript
   export function computePercentile(sorted: readonly number[], percentile: number): number | null {
     if (sorted.length === 0) return null;
     const index = Math.floor((sorted.length - 1) * percentile);
     return sorted[index] ?? null;
   }
   ```
2. Open `src/metrics/latency-tracker.ts`. Find the percentile calculation at lines 74-76.
3. Import the helper at the top: `import { computePercentile } from './percentile.js';`
4. Replace the existing percentile-index logic with calls to `computePercentile(sorted, 0.5)`, `computePercentile(sorted, 0.95)`, `computePercentile(sorted, 0.99)`.
5. Open `src/metrics/session-tracker.ts`. Find `computeP95` near line 60.
6. Replace its body with `return computePercentile(sorted, 0.95);` (or delete the helper and inline the import).
7. Build: `npm run build`. Must succeed.
8. Run: `npx jest -- src/metrics/latency-tracker.test.ts src/metrics/session-tracker.test.ts`.
9. Add a unit test for `percentile.ts` (e.g. `src/metrics/percentile.test.ts`) covering: empty array → null; single element → that element; 100 sorted elements → expected p50/p95/p99 indices.
10. Run: `npm run lint`.~~

---

### ~~[F-012] NerdGraph result fields silently coerced to `NaN` — High (TYPE) ✅~~
~~**Location:** `src/tools/cross-session-tools.ts:668-693`~~
~~**Issue:** `Number(row.totalCost ?? 0)`, `Number(row.avgScore)`, `Number(row.antiPatterns ?? 0)` — `Number()` returns `NaN` when the underlying value is non-numeric, but the type system reports it as `number`. There is no `Number.isFinite()` check before the value is added to a running total.~~
~~**Impact:** A single malformed NR response poisons the entire team summary with `NaN` totals, propagating downward through every aggregation.~~
~~**Suggested fix:** After every `Number(...)` coercion at this boundary, guard with `Number.isFinite()` and either substitute 0 or throw. Best to centralise via a `toFiniteNumber(x: unknown, fallback = 0): number` helper.~~

~~**Implementation steps for Haiku:**

1. Open `src/tools/cross-session-tools.ts`. Locate the team-summary aggregation block at lines 668-693.
2. Above that function (or in a small utilities section near the top of the file), add:
   ```typescript
   function toFiniteNumber(x: unknown, fallback = 0): number {
     const n = Number(x);
     return Number.isFinite(n) ? n : fallback;
   }
   ```
3. Replace each `Number(row.<field> ?? 0)` and `Number(row.<field>)` call in lines 668-693 with `toFiniteNumber(row.<field>)`. Concretely:
   - `Number(row.totalCost ?? 0)` → `toFiniteNumber(row.totalCost)`
   - `Number(row.avgScore)` → `toFiniteNumber(row.avgScore)`
   - `Number(row.antiPatterns ?? 0)` → `toFiniteNumber(row.antiPatterns)`
   - Apply to every other `Number(...)` call in this block.
4. Build: `npm run build`. Must succeed.
5. Run: `npx jest -- src/tools/cross-session-tools.test.ts`.
6. Add a regression test that mocks NerdGraph to return a row with a non-numeric field (e.g. `{ totalCost: 'abc' }`) and asserts the team summary's totals are 0 (not `NaN`).
7. Run: `npm run lint`.~~

---

### ~~[F-013] MCP tool input validation bypass via `as unknown as` — High (TYPE) ✅~~
~~**Location:** `src/tools/session-stats.ts:373, 403-407`~~
~~**Issue:** `handleReportTokens(costTracker, args as unknown as TokenReport, modelUsageTracker)` and the analogous `feedbackArgs = args as unknown as { quality: 'good' | 'bad' | 'neutral'; ... }` both bypass any runtime validation. The handlers assume required fields are present and well-typed.~~
~~**Impact:** A misbehaving or malicious MCP client sending malformed input can crash the handler or, worse, cause silent miscounting (e.g. negative token totals, NaN costs).~~
~~**Suggested fix:** Add zod schemas (or hand-rolled type guards) at every MCP boundary. Per the project conventions in CLAUDE.md, MCP tools register zod schemas on `server.tool(...)` — verify those are wired through `args` instead of being skipped.~~

~~**Implementation steps for Haiku:**

1. Open `src/tools/session-stats.ts`. Locate line 373 with `args as unknown as TokenReport` and lines 403-407 with `args as unknown as { quality: 'good' | 'bad' | 'neutral'; ... }`.
2. At the top of the file (after existing imports), add: `import { z } from 'zod';`
3. Define schemas just above the tool registration block:
   ```typescript
   const TokenReportSchema = z.object({
     model: z.string().min(1),
     input_tokens: z.number().nonnegative(),
     output_tokens: z.number().nonnegative(),
     cache_creation_tokens: z.number().nonnegative().optional(),
     cache_read_tokens: z.number().nonnegative().optional(),
     thinking_tokens: z.number().nonnegative().optional(),
   });
   const FeedbackSchema = z.object({
     quality: z.enum(['good', 'bad', 'neutral']),
     task_id: z.string().optional(),
     notes: z.string().optional(),
   });
   ```
4. Replace `args as unknown as TokenReport` with `TokenReportSchema.parse(args)`. Wrap in try/catch — if `parse` throws, return `{ content: [...], isError: true }` with the validation message.
5. Replace `args as unknown as { quality: 'good' | 'bad' | 'neutral'; ... }` with `FeedbackSchema.parse(args)`. Same try/catch pattern.
6. Build: `npm run build`. Must succeed.
7. Run: `npx jest -- src/tools/session-stats.test.ts`.
8. Add negative tests: invalid token-report (negative tokens, missing model), invalid feedback (`quality: 'great'`). Assert `isError: true`.
9. Run: `npm run lint`.~~

---

### ~~[F-014] HarvestScheduler restart re-registers process listeners — High (LIFE) ⚠️~~
~~**Location:** `src/shared/harvest/harvest-scheduler.ts:115-116` *(fix upstream in nr-ai-typescript-shared)*~~
~~**Issue:** `start()` registers `beforeExit` and `SIGTERM` listeners with `process.once()`. The class is idempotent for "already running" (early return at line 97-99), but if `stop()` is called and then `start()` is called again, fresh listeners are registered without removing the previous ones. In proxy mode, an upstream restart can trigger this pattern.~~
~~**Impact:** On the next signal, multiple flushes race; events can be sent twice or partial batches emitted.~~
~~**Suggested fix:** In `stop()`, explicitly `process.removeListener` the bound handlers. In `start()`, double-check no prior listeners exist before re-registering.~~

~~**Verification:** ⚠️ PARTIAL — HarvestScheduler uses `process.once()` for both signals, so listeners auto-remove on signal fire — no leak in normal operation. The concern only applies if `start()` is called twice without an intervening signal/stop, which is uncommon. This is already correctly implemented in the current codebase:~~
- ~~Lines 115-116: Uses `process.once()` which auto-removes listeners on signal fire~~
- ~~Lines 144-145: Calls `process.removeListener()` in `doStop()` for defensive cleanup~~
~~No action required — the defensive pattern is already in place.~~

---

## Medium severity

### ~~[F-015] `highSecurity=true` is enforceable in main config but bypassable via env in collector — Medium (SEC)~~ ✅
**Location:** `src/config.ts:323-327`, `src/hooks/collector-script.ts:228, 251`
**Issue:** The main config loader forces `recordContent: false` when `highSecurity` is true. The collector script reads `recordContent` from `NEW_RELIC_AI_MCP_RECORD_CONTENT` independently and has no awareness of the `highSecurity` flag. If the env var is set inconsistently, content can still be captured by the hook collector even when the server config says high-security mode is on.
**Impact:** A misconfigured high-security deployment silently captures content the customer believed was off-limits — a serious trust violation given the brief's compliance positioning.
**Suggested fix:** Pass the resolved `highSecurity` setting to the collector via env (or a derived `recordContent` value the collector trusts), and make the collector enforce the same invariant. Alternatively, have the collector read the same config file the server reads.

**Implementation steps for Haiku:**

~~1. Open `src/config.ts`. After `recordContent` is resolved (around line 324), expose the `highSecurity` flag through the existing collector-env mechanism.~~
~~2. In the install/setup wizard (`src/install/setup-wizard.ts`), when generating the hook command line, pass `NEW_RELIC_AI_MCP_HIGH_SECURITY=true` if `highSecurity` is set.~~
~~3. Open `src/hooks/collector-script.ts`. Near line 34 where `getRecordContent()` reads `NEW_RELIC_AI_MCP_RECORD_CONTENT`, add a parallel check: `const highSecurity = process.env.NEW_RELIC_AI_MCP_HIGH_SECURITY === 'true';`~~
~~4. In `getRecordContent()`, if `highSecurity` is true, return `false` regardless of the other env var: `if (highSecurity) return false;`~~
~~5. Build: `npm run build`.~~
~~6. Add a test in `src/hooks/collector-script.test.ts`: set `NEW_RELIC_AI_MCP_HIGH_SECURITY=true` and `NEW_RELIC_AI_MCP_RECORD_CONTENT=true`, call `getRecordContent()`, assert `false`.~~
~~7. Run tests: `npx jest -- src/hooks/collector-script.test.ts`.~~
~~8. Run: `npm run lint`.~~

**COMPLETED:** Added `getHighSecurity()` function that checks both `NEW_RELIC_AI_MCP_HIGH_SECURITY` env var and config file's `highSecurity` flag. Modified `getRecordContent()` to enforce `highSecurity` setting — when high-security is enabled, content recording is always forced to false regardless of other settings. Exported `getRecordContent()` for testing and added tests verifying env var enforcement.

---

### ~~[F-016] Slack webhook URL has no SSRF validation in `digest-sender.ts` — Medium (SEC)~~ ✅
**Location:** `src/digest/digest-sender.ts:1-10`
**Issue:** `sendSlackDigest()` accepts any string `webhookUrl` and passes it directly to `fetch()`. SSRF protection currently exists only at the caller site (`cross-session-tools.ts:712` checks the `https://hooks.slack.com/` prefix). Other call paths or future surfaces that pass a different URL bypass that check entirely.
**Impact:** If an attacker writes the config file or sets the env var, the digest can be redirected to an arbitrary URL — leaking the digest contents (developer names, costs, anti-patterns) and turning the process into an SSRF vector.
**Suggested fix:** Validate inside `sendSlackDigest()`: require `https://hooks.slack.com/` prefix, or call `validateSsrfUrl()` from `src/security/ssrf.ts`. Defence-in-depth.

**Implementation steps for Haiku:**

~~1. Open `src/digest/digest-sender.ts`.~~
~~2. At the top of `sendSlackDigest()` (just after the function signature), add validation:~~
   ```typescript
   if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
     throw new Error('Invalid webhook URL: must start with https://hooks.slack.com/');
   }
   ```
~~3. Build: `npm run build`.~~
~~4. Add a test in `src/digest/digest-sender.test.ts` (create if missing): assert that `sendSlackDigest('http://evil.com/x', payload)` throws.~~
~~5. Run tests: `npx jest -- src/digest`.~~
~~6. Run: `npm run lint`.~~

**COMPLETED:** Added SSRF validation at the top of `sendSlackDigest()` to enforce `https://hooks.slack.com/` prefix on all webhook URLs. Created comprehensive test suite with 7 test cases covering valid Slack URLs, invalid domains, HTTP URLs, localhost, and internal IP addresses. All tests passing, no lint errors.

---

### ~~[F-017] Error messages from `collector-script.ts` not redacted before persisting — Medium (SEC)~~ ✅
**Location:** `src/hooks/collector-script.ts:263`
**Issue:** `error: data.error ?? 'unknown error'` is written into the buffer without `redact()`. The error string can carry stack traces, file paths, or — worst case — secret values that surfaced in an exception message.
**Impact:** Buffer file (then NR events) contains unredacted error contents.
**Suggested fix:** Wrap with `redact()`: `error: redact(data.error ?? 'unknown error')`.

**Implementation steps for Haiku:**

~~1. Open `src/hooks/collector-script.ts`. Verify `redact` is imported at the top (it should already be — search for `redact`).~~
~~2. Locate line 263, currently `error: data.error ?? 'unknown error'`.~~
~~3. Replace with: `error: redact(data.error ?? 'unknown error')`.~~
~~4. Build: `npm run build`.~~
~~5. Add a test in `src/hooks/collector-script.test.ts` that constructs a `PostToolUseFailure` event with an error string containing `Bearer abc123` and asserts the persisted event's `error` field is redacted.~~
~~6. Run: `npx jest -- src/hooks/collector-script.test.ts`.~~
~~7. Run: `npm run lint`.~~

**COMPLETED:** Wrapped error messages with `redact()` to sanitize sensitive information before persisting to buffer. Added two test cases verifying that Bearer tokens and API keys are properly redacted in error messages. All tests passing, no lint errors.

---

### [F-018] `session-store.ts` path validation is post-construction TOCTOU — Medium (SEC) ❌
**Location:** `src/storage/local-store.ts:117-124` (LocalStore — same pattern likely in SessionStore)
**Issue:** Filename regex `/^[A-Za-z0-9_-]{1,128}$/` is checked at line 94, then path is constructed and `filepath.startsWith(this.sessionsDir + sep)` is checked at line 123. If the sessions directory is replaced with a symlink between the two checks (TOCTOU), traversal is theoretically possible. The regex check is the primary defence; the post-construction check is redundant but does not actually defeat symlink races.
**Impact:** Low practical risk because the regex already rejects `..` characters, but the redundant check creates a false sense of security and a maintenance trap.
**Suggested fix:** Resolve the path with `realpathSync` and compare resolved paths, or rely solely on the regex check and remove the post-construction one (with a comment).

**Implementation steps for Haiku:**

1. Open `src/storage/local-store.ts`. Locate the path-validation block at lines 117-124.
2. Above the `filepath.startsWith(...)` check, add a comment: `// Defence-in-depth check; the regex on line 94 is the primary defence.`
3. (Optional, more thorough) Replace the post-construction check with a `realpathSync` resolution:
   ```typescript
   import { realpathSync } from 'node:fs';
   const resolvedSessionsDir = realpathSync(this.sessionsDir);
   const resolvedFilepath = realpathSync.native ? realpathSync(filepath) : filepath;
   if (!resolvedFilepath.startsWith(resolvedSessionsDir + sep)) { throw new Error(...); }
   ```
   Note: `realpathSync` will throw if the file doesn't exist yet — so call it on the *parent* dir, then concatenate the filename.
4. Build: `npm run build`.
5. Run: `npx jest -- src/storage/local-store.test.ts`.
6. Run: `npm run lint`.

**Verification:** ❌ FALSE POSITIVE — No TOCTOU window — regex validation happens pre-construction at line 94, before path resolution.

---

### ~~[F-019] `taskDetector!.getMetrics()` non-null assertion in shutdown can crash — Medium (CORR)~~ ✅
**Location:** `src/index.ts:141-146`
**Issue:** Shutdown handler calls `taskDetector!.getMetrics()` with a non-null assertion. `taskDetector` is only initialised on the stdio code path (around line 200). If startup fails before that initialisation (e.g. config-load throw), shutdown crashes with "Cannot read properties of undefined."
**Impact:** Clean shutdown is broken on early-failure paths; exit code may be wrong; subsequent cleanup steps don't run.
**Suggested fix:** Replace the non-null assertion with a guard: `if (taskDetector) { ... }`.

**Implementation steps for Haiku:**

~~1. Open `src/index.ts`. Locate the shutdown handler at lines 141-146.~~
~~2. Find the line `const taskMetrics = taskDetector!.getMetrics();` (or similar non-null assertion).~~
~~3. Replace with a guard:~~
   ```typescript
   if (!taskDetector) {
     logger.info('Shutdown before taskDetector init; skipping task metrics');
     return;
   }
   const taskMetrics = taskDetector.getMetrics();
   ```
~~4. Search the file for any other `taskDetector!` non-null assertions and apply the same guard pattern.~~
~~5. Build: `npm run build`.~~
~~6. Run: `npx jest`.~~
~~7. Run: `npm run lint`.~~

**COMPLETED:** Removed all non-null assertions on taskDetector throughout src/index.ts. Added defensive guard at top of onRecord callback to ensure config, sessionTracker, and taskDetector are defined before use. Updated persistSession to guard against undefined values for config, sessionTracker, taskDetector before accessing them. All tests passing (1714 tests), no lint errors. Graceful shutdown now safe even on early-failure paths.

---

### ~~[F-020] `BudgetTracker` `firedThresholds` Set is never cleared at period rollover — Medium (CORR)~~ ✅
**Location:** `src/metrics/budget-tracker.ts:81-104`
**Issue:** `firedThresholds` records keys like `${period}:${pct}` to deduplicate alerts within a period. Once 50% fires for "today", the entry stays forever. When the calendar rolls over to the next day, the daily budget resets but the de-dup set still says "we already fired the 50% alert."
**Impact:** Daily / weekly budget alerts go silent after the first period in which they fire. Users miss subsequent period overages.
**Suggested fix:** Track which calendar period each entry corresponds to and prune entries whose period is no longer current. Simplest implementation: stamp each entry with `dayId`/`weekId` and clear stale ones on every `updateCost` call.

**Implementation steps for Haiku:**

~~1. Open `src/metrics/budget-tracker.ts`. Locate `firedThresholds` (around lines 81-104) and the `updateCost` method.~~
~~2. Replace `firedThresholds: Set<string>` with `firedThresholds: Map<string, string>` where the value stores a period stamp like `'day:2026-05-21'` or `'week:2026-W21'`.~~
~~3. Add a private helper `private currentPeriodId(period: 'day' | 'week' | 'month'): string` that returns `'day:YYYY-MM-DD'`, `'week:YYYY-Www'`, etc. based on the current date.~~
~~4. In `updateCost`, before checking thresholds, prune entries from `firedThresholds` whose period stamp doesn't match the current period.~~
~~5. When firing a threshold, store the current period id as the value.~~
~~6. Build: `npm run build`.~~
~~7. Add a test that fakes `Date.now()` (use `jest.useFakeTimers()`) to advance past midnight and asserts the daily threshold fires again.~~
~~8. Run: `npx jest -- src/metrics/budget-tracker.test.ts`.~~
~~9. Run: `npm run lint`.~~

**COMPLETED:** Replaced `firedThresholds` Set with Map storing period IDs (day:YYYY-MM-DD, week:YYYY-Www). Added `currentPeriodId()` helper to compute calendar-based period identifiers. Added `pruneStaleThresholds()` called at start of `checkThresholds()` to clear de-dup entries for expired periods. Created two comprehensive tests using fake timers to verify daily and weekly thresholds re-fire after period rollover. All 1718 tests passing, no lint errors.

---

### ~~[F-021] NR event timestamps lose millisecond precision — Medium (CORR)~~ ✅
**Location:** `src/transport/nr-ingest.ts:117, 166, 199, 235, 240, 241, 280, 498`
**Issue:** Every `timestamp` field is built as `Math.floor(record.timestamp / 1000)`, converting epoch-ms to epoch-seconds. NR's Events API accepts millisecond timestamps natively.
**Impact:** Two events emitted within the same wall-clock second collide on timestamp; ordering ambiguity in dashboards; sub-second TIMESERIES bucketing impossible.
**Suggested fix:** Drop the `Math.floor(... / 1000)` and pass millisecond timestamps directly. NR Events API accepts both — verify via NR docs first, then update.

**Implementation steps for Haiku:**

~~1. Verify in New Relic Events API documentation that the `timestamp` field accepts milliseconds. (Spoiler: yes — the API accepts both seconds and milliseconds since epoch.)~~
~~2. Open `src/transport/nr-ingest.ts`.~~
~~3. At each of these lines: 117, 166, 199, 235, 240, 241, 280, 498 — find the pattern `Math.floor(record.timestamp / 1000)` (or similar `/1000` conversions on a timestamp).~~
~~4. Replace each with the bare `record.timestamp` (or whatever the source variable is).~~
~~5. Build: `npm run build`.~~
~~6. Add a test: emit an event, drain via the test ingest mock, assert `event.timestamp` matches the original ms-precision value.~~
~~7. Run: `npx jest -- src/transport/nr-ingest.test.ts`.~~
~~8. Run: `npm run lint`.~~

**COMPLETED:** Removed all 8 instances of `Math.floor(... / 1000)` conversions from nr-ingest.ts, now passing millisecond-precision timestamps directly to NR Events API. Updated three test cases to verify millisecond-precision timestamps preserved. Events now maintain full sub-second ordering and enable TIMESERIES bucketing at millisecond granularity. All 1718 tests passing, no lint errors.

---

### ~~[F-022] `isProxyToolCall` type guard checks key presence but not types — Medium (TYPE)~~ ✅
~~**Location:** `src/transport/nr-ingest.ts:152-155`~~
~~**Issue:** Type guard returns `'serverName' in record && 'upstreamLatencyMs' in record`. Doesn't verify the values are the right types. A record with `serverName: null, upstreamLatencyMs: 'broken'` passes the guard, then `proxyToolCallToNrEvent()` later crashes or emits wrong types.~~
~~**Impact:** Runtime errors or malformed NR events under unexpected upstream-record shapes.~~
~~**Suggested fix:** `return typeof record.serverName === 'string' && typeof record.upstreamLatencyMs === 'number'`.~~

~~**Implementation steps for Haiku:**

1. Open `src/transport/nr-ingest.ts`. Locate `isProxyToolCall` at lines 152-155.
2. Replace the function body with:
   ```typescript
   return (
     'serverName' in record &&
     typeof (record as Record<string, unknown>).serverName === 'string' &&
     'upstreamLatencyMs' in record &&
     typeof (record as Record<string, unknown>).upstreamLatencyMs === 'number'
   );
   ```
3. Build: `npm run build`.
4. Add a test that passes a record with `serverName: null` and asserts `isProxyToolCall` returns `false`.
5. Run: `npx jest -- src/transport/nr-ingest.test.ts`.
6. Run: `npm run lint`.~~

**COMPLETED:** Updated `isProxyToolCall` type guard to validate both key presence AND types. Now checks `typeof record.serverName === 'string'` and `typeof record.upstreamLatencyMs === 'number'`. Exported function for testing. Added 7 comprehensive test cases covering invalid types (null, number, string), missing keys, and valid records. All 1723 tests passing, no lint errors.

---

### [F-023] EfficiencyScorer appends duplicate scores for same task — Medium (CORR) ❌
**Location:** `src/metrics/efficiency-score.ts:99-104`
**Issue:** `updateScore()` finds the existing score by `taskId` (line ~99), but the code path that follows still calls `appendScore()` which always pushes. Old entry remains in the array; only the cap (`MAX_SCORES = 1000`) eventually trims it.
**Impact:** Long sessions accumulate duplicate task scores, inflating the `scores` array, slowing aggregations, and causing incorrect averages until the cap kicks in.
**Suggested fix:** When `idx >= 0`, mutate `this.scores[idx] = result` and return. Only call `appendScore()` for genuinely new tasks.

**Implementation steps for Haiku:**

1. Open `src/metrics/efficiency-score.ts`. Locate `updateScore()` near lines 99-104.
2. Find the `if (idx >= 0)` branch. Verify the existing logic only replaces `this.scores[idx]` and does NOT also call `appendScore()`. (Per verification, the paths are already mutually exclusive — this finding was reclassified, but tighten the code clarity.)
3. Add an explicit early `return` after `this.scores[idx] = result;` to make the mutual exclusion obvious.
4. Build: `npm run build`. Run: `npx jest -- src/metrics/efficiency-score.test.ts`.

**Verification:** ❌ FALSE POSITIVE — EfficiencyScorer paths are mutually exclusive (`if (idx >= 0)` replaces, `else` appends); no duplicate path exists.

---

### ~~[F-024] TaskDetector `linesAdded`/`linesRemoved` are mutually exclusive — Medium (CORR)~~ ✅
~~**Location:** `src/metrics/task-detector.ts:115-120`~~
~~**Issue:** The diff math is `linesAdded += max(0, newLines - oldLines)` and `linesRemoved += max(0, oldLines - newLines)`. This treats an Edit as net additions OR net removals — but a real Edit can both add and remove lines.~~
~~**Impact:** Code-churn metrics are wrong: a refactor that drops 10 lines and adds 12 reports `linesAdded=2, linesRemoved=0` instead of `linesAdded=12, linesRemoved=10`.~~
~~**Suggested fix:** Parse the actual edit (Edit/Write tool input has both before and after counts) and record additions/removals from the diff, not from net line count.~~

~~**Implementation steps for Haiku:**

1. Open `src/metrics/task-detector.ts`. Locate the lines-counting logic at 115-120.
2. Investigate the source of `oldLines` and `newLines`. If they come from `record.oldLineCount` / `record.newLineCount`, the current math reports net diff, not gross.
3. Switch to using the actual diff content if available (the Edit tool input's `old_string` / `new_string` line counts). For each edit, count newlines in each: `addedLines = (newString.match(/\n/g) ?? []).length`, `removedLines = (oldString.match(/\n/g) ?? []).length`. Add both unconditionally.
4. If diff content isn't available at this layer, fall back to net diff but mark the metric as approximate.
5. Build: `npm run build`. Run: `npx jest -- src/metrics/task-detector.test.ts`.
6. Add a test where `oldString` has 5 newlines and `newString` has 7 — assert `linesAdded += 7, linesRemoved += 5`.~~

**COMPLETED:** Changed Edit line counting to track gross additions and removals instead of net diff. Now `linesAdded += newLines` and `linesRemoved += oldLines` unconditionally, correctly reporting refactors that both add and remove lines. Updated existing test expectations: edit from 10→15 lines now reports linesAdded=65 (50+15), linesRemoved=10 instead of linesAdded=55, linesRemoved=0. Added comprehensive test case demonstrating the fix. All 1724 tests passing, no lint errors.

---

### ~~[F-025] PersonalCoach `mean([])` divides by zero → `NaN` — Medium (CORR)~~ ✅
~~**Location:** `src/metrics/personal-coach.ts:165`~~
~~**Issue:** Helper `mean(values)` returns `values.reduce((a,b) => a+b, 0) / values.length`. When `values.length === 0`, returns `NaN`.~~
~~**Impact:** Personal-coaching report can return `NaN` baselines, breaking downstream comparisons and rendering UI.~~
~~**Suggested fix:** Return `0` (or `null`) when `values.length === 0`. Choose `null` if downstream consumers can handle it, otherwise fall through to `0`.~~

~~**Implementation steps for Haiku:**

1. Open `src/metrics/personal-coach.ts`. Locate the `mean()` helper at line 165.
2. Add an empty-array guard:
   ```typescript
   function mean(values: number[]): number {
     if (values.length === 0) return 0;
     return values.reduce((a, b) => a + b, 0) / values.length;
   }
   ```
3. Build: `npm run build`. Run: `npx jest -- src/metrics/personal-coach.test.ts`.
4. Add a test: `mean([])` returns 0, not NaN.~~

**COMPLETED:** Added empty-array guard to `mean()` helper in PersonalCoach.computeBaseline(). Now returns 0 when passed an empty array instead of NaN. Added comprehensive test that verifies all baseline metrics are finite numbers (not NaN or Infinity). All 1725 tests passing, no lint errors.

---

### ~~[F-026] AntiPattern thrashing detector resets `lastEditFile` after a passing test — Medium (CORR)~~ ✅
~~**Location:** `src/metrics/anti-patterns.ts:136-138`~~
~~**Issue:** When a test passes the thrashing cycle counter resets to 0, *and* `lastEditFile = null`. The next failing test on the same file starts the counter from scratch — the `[fail, pass, fail, fail]` pattern gets reported as 1 thrash instead of 2.~~
~~**Impact:** Real thrashing on flaky tests under-reports.~~
~~**Suggested fix:** Only clear `lastEditFile` when switching to a different file, not on every passing test.~~

~~**Implementation steps for Haiku:**

1. Open `src/metrics/anti-patterns.ts:136-138`. Find the lines that set the cycle counter to 0 and `lastEditFile = null` on a passing test.
2. Remove the `lastEditFile = null` line. Keep the counter reset.
3. Add a test for `[edit /a, fail, pass, fail, fail]` and verify thrashing fires (cycles ≥ 2).
4. Build + test: `npm run build && npx jest -- src/metrics/anti-patterns.test.ts && npm run lint`.~~

**COMPLETED:** Removed unconditional `lastEditFile = null` after test commands. Now `lastEditFile` persists across consecutive tests and only gets cleared when switching to a different file via Edit/Write. This allows proper tracking of thrashing cycles on flaky tests that fail again after passing. Added test for `[edit /a, fail, pass, fail, fail]` sequence with custom threshold to verify the pattern is correctly detected. All 1726 tests passing, no lint errors.

---

### ~~[F-027] `computeReadEfficiency()` may not be implemented — Medium (CORR)~~ ✅
~~**Location:** `src/metrics/anti-patterns.ts` (`computeReadEfficiency` referenced around line 95)~~
~~**Issue:** Agent flagged that the helper is referenced but its body wasn't found in the inspected snippet. If unimplemented or returning undefined, `AntiPatternMetrics.readEfficiency` is always null.~~
~~**Impact:** A documented metric is silently absent from outputs.~~
~~**Suggested fix:** Verify the implementation exists, returns a number, and is unit-tested. If genuinely missing, implement it (or remove the referenced field).~~

~~**Implementation steps for Haiku:**

1. Open `src/metrics/anti-patterns.ts`. Search for `computeReadEfficiency`. Per verification it exists at lines 305-319.
2. Audit its body: confirm it computes a meaningful ratio (e.g. unique-files-read / total-reads) and returns a finite number or `null`.
3. Add a unit test exercising it with: 0 reads (expect null), 5 unique reads of 5 files (expect 1.0), 5 reads of 1 file (expect 0.2).
4. Build + test: `npm run build && npx jest -- src/metrics/anti-patterns.test.ts`.~~

**COMPLETED:** Verified `computeReadEfficiency()` implementation at lines 307-321 computes unique-files-read / total-reads ratio, returns finite number or null (on 0 reads). Existing tests already covered 0 reads (null). Added two comprehensive test cases: 5 unique reads of 5 different files (expect 1.0 perfect efficiency), and 5 reads of same file (expect 0.2 inefficient). All 1728 tests passing, no lint errors.

---

### ~~[F-028] LatencyTracker reports p95/p99 as `0` for empty samples — Medium (CORR) ✅~~
~~**Location:** `src/metrics/latency-tracker.ts:74`~~
~~**Issue:** When `sorted.length === 0`, `Math.floor(0 * 0.95) === 0`, `sorted[0]` is `undefined`, then `?? 0` makes the percentile `0`. The return type allows `null`, so `null` would be the truthful value.~~
~~**Impact:** Dashboards display a misleading `0ms p95` for sessions with no samples — looks like "extremely fast" instead of "no data".~~
~~**Suggested fix:** Return `null` (or omit the entry) when `sorted.length === 0`.~~

~~**Implementation steps for Haiku:** In `src/metrics/latency-tracker.ts:74`, change `?? 0` to `?? null` for each percentile line, and update the return type to `LatencyPercentiles | null`. Update consumers to handle `null` (display "—" rather than `0ms`). `npm run build && npx jest -- src/metrics/latency-tracker.test.ts && npm run lint`.~~

---

### [F-029] TaskDetector `idleTimer` is never disposed — Medium (LIFE) ❌
**Location:** `src/metrics/task-detector.ts:316-321` and `src/index.ts:140-156`
**Issue:** TaskDetector exposes a `dispose()` method that clears the idle timer, but no caller invokes it. Long-running sessions where `taskDetector` is GC'd leave a pending `setTimeout` that fires and calls `closeCurrentTask()` on a dead instance.
**Impact:** Unawaited timeouts in tests; in production, slight memory retention until the timer fires.
**Suggested fix:** Call `taskDetector.dispose()` in the shutdown handler before tearing down related resources. Make sure the call is guarded (`taskDetector?.dispose?.()`).

**Implementation steps for Haiku:** In `src/index.ts` shutdown handler (lines 140-156), add `taskDetector?.dispose?.();` near the top of the cleanup block. `npm run build && npx jest && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — `taskDetector.dispose()` IS called in `src/index.ts:147` during shutdown.

---

### ~~[F-030] NrIngestManager session-gauge interval can race against shutdown — Medium (LIFE) ✅~~
~~**Location:** `src/transport/nr-ingest.ts:527-543`~~
~~**Issue:** `stop()` clears `sessionGaugeIntervalId` (line 529-531) and *then* calls `emitSessionGauges()` (line 535). If the interval was firing concurrently with `stop()`, the in-flight `emitSessionGauges()` may complete after the harvest scheduler has been stopped, dropping the final gauges.~~
~~**Impact:** Final session gauges occasionally lost on shutdown.~~
~~**Suggested fix:** Reorder: call `emitSessionGauges()` *first* (with its existing `running` guard), then clear the interval. Add an `await` if the gauge emit is async.~~

~~**Implementation steps for Haiku:** In `src/transport/nr-ingest.ts:527-543`, swap the order: `await this.emitSessionGauges();` first, then `clearInterval(this.sessionGaugeIntervalId)`. `npm run build && npx jest -- src/transport/nr-ingest.test.ts && npm run lint`.~~

---

### ~~[F-031] Tool call span double-end risk on `durationMs === 0` — Medium (CORR) ✅~~
~~**Location:** `src/tracing/tool-call-span.ts:33-46`~~
~~**Issue:** Logic uses `if (record.durationMs !== null)` to gate `end()`. `0` is a valid duration but flow-control around it is fragile; future refactors may double-end.~~
~~**Impact:** OTel SDK warnings or undefined behaviour for zero-duration tool calls.~~
~~**Suggested fix:** Use `if (record.durationMs != null && Number.isFinite(record.durationMs))` to be explicit. Track an `ended` flag to defend against double-end at any time.~~

~~**Implementation steps for Haiku:** In `src/tracing/tool-call-span.ts:33`, change `if (record.durationMs !== null)` to `if (record.durationMs != null && Number.isFinite(record.durationMs))`. Add a private `ended: boolean = false` flag and check it before calling `span.end(...)`. `npm run build && npx jest -- src/tracing && npm run lint`.~~

---

### ~~[F-032] `AiAntiPattern` event field is `type` — match memory's "field naming" convention or document — Medium (DOC) ✅~~
~~**Location:** `src/transport/nr-ingest.ts:281` (sets the `type` field)~~
~~**Issue:** The saved memory `reference_nr_event_schema` notes that AiAntiPattern uses `type` (not `patternType`). The agent flagged `type` as a possible deviation from convention. After cross-referencing the memory, `type` is the *current correct* field name. **This is a reminder finding, not a defect** — but Agent D specifically flagged it as a problem, so document the convention here so the question doesn't recur.~~
~~**Impact:** None if `type` is intentional; renaming would break dashboards.~~
~~**Suggested fix:** Add a comment in `nr-ingest.ts:281` referencing `reference_nr_event_schema` so future readers don't mistake this for a bug.~~

~~**Implementation steps for Haiku:** In `src/transport/nr-ingest.ts:281`, above the line setting `type: pattern.type`, add the comment: `// Field name is intentionally 'type' (not 'patternType') — used by all NRQL queries and dashboards. Do not rename.` No code change. `npm run build && npm run lint`.~~

---

### ~~[F-033] Config file parse failure silently falls back to defaults — Medium (CORR) ✅~~
~~**Location:** `src/config.ts:150-167` (`loadConfigFile`)~~
~~**Issue:** On `JSON.parse` error, the function logs and returns `{}`. Defaults then take over. Customers writing invalid JSON have no clear signal.~~
~~**Impact:** Misconfigurations look like "the product ignored my settings" instead of "your config is broken." Hard to diagnose for support.~~
~~**Suggested fix:** Throw on parse error (or exit with non-zero code) — fail loudly. Log the JSON parse error message verbatim so the customer can fix it.~~

~~**Implementation steps for Haiku:** In `src/config.ts:150-167` `loadConfigFile()`, replace `return {}` on parse error with `throw new Error(\`Invalid JSON in config file ${path}: ${err.message}\`);`. Add a test that passes malformed JSON and asserts the throw with a clear message. `npm run build && npx jest -- src/config.test.ts && npm run lint`.~~

---

### [F-034] Digest formatter crashes on empty `antiPatternCounts` — Medium (CORR) ❌
**Location:** `src/digest/digest-formatter.ts:6-8`
**Issue:** `Object.entries(summary.antiPatternCounts).sort(...).pop()` returns `undefined` when the object is empty. Subsequent `topAntiPatternEntry[0]` access throws `TypeError: cannot read properties of undefined`.
**Impact:** Weekly digest fails for any week with no detected anti-patterns — a normal occurrence for low-activity weeks.
**Suggested fix:** Guard with optional chaining and a default: `const topAntiPattern = topAntiPatternEntry?.[0] ?? 'none';`

**Implementation steps for Haiku:** In `src/digest/digest-formatter.ts:6-8`, change `topAntiPatternEntry[0]` to `topAntiPatternEntry?.[0] ?? 'none'`. Add a test for empty `antiPatternCounts: {}`. `npm run build && npx jest -- src/digest && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — The code DOES handle empty `antiPatternCounts` — the `topAntiPattern` assignment (line 8) accepts `undefined`.

---

### ~~[F-035] Generic MCP adapter validation only checks two fields — Medium (TYPE) ✅~~
~~**Location:** `src/platforms/generic-mcp-adapter.ts:91`~~
~~**Issue:** `validateReportToolCallInput` checks `tool` and `success`, then casts to `ReportToolCallInput`. Optional fields (`duration_ms`, `error`, `timestamp`) are not type-checked. A caller passing `duration_ms: "not a number"` produces silent NaN downstream.~~
~~**Impact:** Latency tracking sees NaN; downstream aggregations produce NaN totals.~~
~~**Suggested fix:** Validate every numeric/string optional field's type when present (`typeof input.duration_ms === 'number'` etc.).~~

~~**Implementation steps for Haiku:** In `src/platforms/generic-mcp-adapter.ts:91`, expand `validateReportToolCallInput()` to check every optional field's type when present. For each of `duration_ms`, `error`, `timestamp`, etc.: `if (obj.X !== undefined && typeof obj.X !== 'expected') throw new Error(...)`. `npm run build && npx jest -- src/platforms && npm run lint`.~~

---

### ~~[F-036] Config file JSON not schema-validated — Medium (TYPE) ✅~~
~~**Location:** `src/config.ts:151-167` and downstream field accesses~~
~~**Issue:** `JSON.parse(raw) as Record<string, unknown>` then field-by-field reads with type coercion. No central schema validation. A field with the wrong type (e.g. `sessionBudgetUsd: "$2"`) silently coerces to `NaN` or falls back to default.~~
~~**Impact:** Silent misconfiguration; bugs are hard to attribute to config typos.~~
~~**Suggested fix:** Define a zod schema for the config file shape, run `safeParse` on the parsed JSON, and surface validation errors with line/field info.~~

~~**Implementation steps for Haiku:** In `src/config.ts`, define `ConfigFileSchema` matching the `McpServerConfig` shape (use `z.object` with `.partial()` since most fields are optional). After `JSON.parse(raw)`, run `ConfigFileSchema.safeParse(parsed)`; on failure, throw with the formatted issues. Add tests for valid + malformed shapes. `npm run build && npx jest -- src/config.test.ts && npm run lint`.~~

---

### ~~[F-037] NerdGraph response error path swallows query failures — Medium (TYPE) ✅~~
~~**Location:** `src/tools/cross-session-tools.ts:706`~~
~~**Issue:** `(json.data?.actor.account.nrql.results ?? []) as Array<...>`. When NR returns an `errors` payload instead of `data`, the `??` falls through to `[]` and the caller treats it as "zero results" instead of "query failed".~~
~~**Impact:** Users see empty dashboards instead of an error message; debugging is harder.~~
~~**Suggested fix:** Check `if (!json.data || json.errors?.length)` first and throw with the NR error message attached.~~

~~**Implementation steps for Haiku:** In `src/tools/cross-session-tools.ts:706`, before the `?? []` fallback, add: `if (!json.data || json.errors?.length) { throw new Error(\`NerdGraph error: ${JSON.stringify(json.errors)}\`); }`. `npm run build && npx jest -- src/tools/cross-session-tools.test.ts && npm run lint`.~~

---

### [F-038] `LocalStore` recovery accepts corrupted `.drain` content as valid — Medium (CORR) ❌
**Location:** `src/storage/local-store.ts:67-80`
**Issue:** Recovery concatenates `.drain` data with current buffer data and writes it back. If `.drain` was corrupted (interrupted write, partial line), the corrupted content poisons the merged buffer.
**Impact:** Subsequent drains fail to parse the merged buffer; events are lost or repeatedly logged as malformed.
**Suggested fix:** During recovery, parse `.drain` line-by-line, skip lines that don't deserialize cleanly, and log how many were skipped.

**Implementation steps for Haiku:** In `src/storage/local-store.ts:67-80`, before merging `.drain` content into the buffer, split by `\n` and JSON.parse each line in a try/catch. Keep only lines that parse. Log `Recovered N valid lines, skipped M malformed lines from .drain`. `npm run build && npx jest -- src/storage/local-store.test.ts && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — Recovery DOES validate line-by-line — each line is parsed in a try/catch (lines 101-108); malformed lines are skipped.

---

### [F-039] `JSON.parse` of buffer.jsonl lines has no type guard — Medium (TYPE) ❌
**Location:** `src/storage/local-store.ts:100-108`
**Issue:** `events.push(JSON.parse(line) as HookEvent)` casts without runtime validation. A malformed line that parses to JSON but is missing `mode`/`tool` slips past and crashes downstream code.
**Impact:** A single bad event in the buffer breaks the drain or pollutes the metric trackers.
**Suggested fix:** Add a `isHookEvent(x: unknown): x is HookEvent` guard and skip lines that fail it (with a warning log).

**Implementation steps for Haiku:** In `src/storage/local-store.ts:100-108`, define `function isHookEvent(x: unknown): x is HookEvent { return typeof x === 'object' && x !== null && 'mode' in x && 'tool' in x && (x as any).mode in {pre: true, post: true}; }`. After JSON.parse, validate with the guard before pushing to events. Log skipped lines. `npm run build && npx jest -- src/storage/local-store.test.ts && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — JSON.parse is wrapped in try/catch (lines 101-107); malformed lines are caught and skipped, not propagated.

---

### ~~[F-040] `parseInt(options.accountId)` no validation in team summary — Medium (TYPE) ✅~~
~~**Location:** `src/tools/cross-session-tools.ts:677`~~
~~**Issue:** `parseInt(options.accountId, 10)` returns `NaN` on undefined/non-numeric input. NaN is then passed to NerdGraph as the account ID.~~
~~**Impact:** Cryptic NerdGraph error instead of a clear "invalid accountId" message; harder to diagnose for users.~~
~~**Suggested fix:** `const accountId = Number(options.accountId); if (!Number.isFinite(accountId)) throw new Error('Invalid accountId: ' + options.accountId);`~~

~~**Implementation steps for Haiku:** In `src/tools/cross-session-tools.ts:677`, replace `parseInt(options.accountId, 10)` with `Number(options.accountId)` followed by an `Number.isFinite()` guard that throws on failure. `npm run build && npx jest -- src/tools/cross-session-tools.test.ts && npm run lint`.~~

---

## Low severity

### ~~[F-041] Process error messages may leak internal paths to MCP clients — Low (SEC) ✅~~
**Location:** `src/proxy/proxy-manager.ts:256-262`
**Issue:** Error messages from failed body reads are serialized into the JSON response without redaction. Internal file paths or stack-trace fragments may end up in client-facing errors.
**Impact:** Information disclosure of internal system details to clients.
**Suggested fix:** Return a generic message (`"request_processing_error"`) and log the verbose detail server-side only.

**Implementation steps for Haiku:** In `src/proxy/proxy-manager.ts:256-262`, replace `message: err.message` (or similar) in the JSON response with a generic string `'request_processing_error'`. Log the full error server-side before returning. `npm run build && npx jest -- src/proxy && npm run lint`.

---

### ~~[F-042] OTLP forward endpoint validated only at construction — Low (SEC) ✅~~
**Location:** `src/proxy/otlp-receiver.ts:19-21`
**Issue:** `otlpForwardEndpoint` is validated in the constructor and used in `forward()` (line ~119) without re-validation. If the receiver options are mutated post-construction (the type has `readonly`, but TS readonly is compile-time only), SSRF could be re-introduced.
**Impact:** Defence-in-depth gap.
**Suggested fix:** Re-validate the endpoint at the top of `forward()`, or use `Object.freeze` on the options.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts` constructor, wrap `this.options = Object.freeze(options);` to make the options immutable. Optionally re-run `validateSsrfUrl()` at the top of `forward()`. `npm run build && npx jest -- src/proxy && npm run lint`.

---

### ~~[F-043] `LatencyTracker.getMetrics()` re-sorts large arrays per call — Low (PERF) ✅~~
**Location:** `src/metrics/latency-tracker.ts:83-98`
**Issue:** Each call to `getMetrics()` sorts and copies every per-tool sample array. With many tools and many samples, this is O(n log n) per call.
**Impact:** Memory and CPU spikes when MCP tools query metrics frequently in long sessions.
**Suggested fix:** Compute percentiles incrementally with a streaming algorithm (e.g. t-digest) instead of storing all samples.

**Implementation steps for Haiku:** In `src/metrics/latency-tracker.ts:83-98`, cache the sorted array as a private `lastSortedAt` map and only re-sort when new samples have been added since the last `getMetrics()` call. As a deeper fix, install `tdigest` from npm and replace per-tool sample arrays with t-digest instances. `npm run build && npx jest -- src/metrics/latency-tracker.test.ts && npm run lint`.

---

### [F-044] `SessionTracker.timeline` silently drops entries beyond cap — Low (CORR) ❌
**Location:** `src/metrics/session-tracker.ts:172-179`
**Issue:** Timeline is capped at `MAX_TIMELINE_ENTRIES` (10,000). When the cap is reached, new entries are dropped silently. No warning, no truncation indicator in `getMetrics()`.
**Impact:** Long sessions lose timeline data after 10,000 calls without notification — debugging is harder.
**Suggested fix:** Either use a ring buffer (drop oldest) or surface a `truncated: true` flag in the metrics output. Log on first overflow.

**Implementation steps for Haiku:** In `src/metrics/session-tracker.ts:172-179`, when at the cap, switch to ring-buffer behavior: `this.timeline.shift()` then `this.timeline.push(entry)`. Add `private timelineTruncated: boolean = false;` set to true on first overflow; expose it in `getMetrics()` output. `npm run build && npx jest -- src/metrics/session-tracker.test.ts && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — `SessionTracker.timeline` does NOT silently drop — the `if` condition prevents append when at cap.

---

### ~~[F-045] BudgetTracker `alerts` array grows unbounded — Low (LIFE) ✅~~
**Location:** `src/metrics/budget-tracker.ts:55-100`
**Issue:** Each threshold crossing pushes to `this.alerts`. No cap or rotation.
**Impact:** Memory grows linearly with threshold crossings during long sessions.
**Suggested fix:** Cap at e.g. 100 entries; evict oldest beyond that.

**Implementation steps for Haiku:** In `src/metrics/budget-tracker.ts:55-100`, after pushing to `this.alerts`, add `if (this.alerts.length > 100) this.alerts.shift();`. `npm run build && npx jest -- src/metrics/budget-tracker.test.ts && npm run lint`.

---

### ~~[F-046] StdioUpstream timeout handle not cleared on happy path — Low (LIFE) ✅~~
**Location:** `src/proxy/upstream-stdio.ts:183-201`
**Issue:** A timeout is created and raced against `client.close()`. On the happy path, the timeout callback fires later (and short-circuits via the `finally` block at line 200), but it would be cleaner to `clearTimeout` immediately after the race resolves.
**Impact:** Minor — every disconnect leaves a benign pending timeout for `disconnectTimeoutMs`.
**Suggested fix:** Capture the result of `Promise.race`, then `clearTimeout(timeoutId)` immediately, then run cleanup.

**Implementation steps for Haiku:** In `src/proxy/upstream-stdio.ts:183-201`, after the `Promise.race(...)` call, add `if (timeoutId !== null) clearTimeout(timeoutId);` before any cleanup. `npm run build && npx jest -- src/proxy/upstream-stdio.test.ts && npm run lint`.

---

### ~~[F-047] ProxyManager `readBody()` timeout not explicitly cleared — Low (LIFE) ✅~~
**Location:** `src/proxy/proxy-manager.ts:385-398` (helper referenced from line 253)
**Issue:** If the body completes before the timeout, the timer is left to GC.
**Impact:** Negligible; small accumulation of pending timeouts under high request load until GC runs.
**Suggested fix:** Explicit `clearTimeout` once the body is read or errored.

**Implementation steps for Haiku:** In `src/proxy/proxy-manager.ts:385-398` (the `readBody` helper / `settle` function), keep a reference to the timeout handle and `clearTimeout` it on both success and error paths. `npm run build && npx jest -- src/proxy/proxy-manager.test.ts && npm run lint`.

---

### [F-048] Drain recovery adds spurious newline when buffer is empty — Low (CORR) ❌
**Location:** `src/storage/local-store.ts:72`
**Issue:** Recovery concat is `drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData`. When `bufferData` is empty and `drainData` doesn't end with newline, an extra trailing newline is appended. The next drain skips the blank line but logs "malformed buffer line" warnings.
**Impact:** Log noise; minor.
**Suggested fix:** `const newBuffer = bufferData ? (drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData) : drainData;`

**Implementation steps for Haiku:** In `src/storage/local-store.ts:72`, replace the unconditional concat with the guarded form: `const newBuffer = bufferData ? (drainData + (drainData.endsWith('\n') ? '' : '\n') + bufferData) : drainData;`. `npm run build && npx jest -- src/storage/local-store.test.ts && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — No spurious newline added — the existing `endsWith('
')` check is correct.

---

### ~~[F-049] Event processor fallback counter could collide on key — Low (CORR) ✅~~
**Location:** `src/hooks/event-processor.ts:44, 175, 283`
**Issue:** When pre-events have no `toolUseId`, the pairing key is `${tool}:${timestamp}:${counter++}`. The counter is a process-local int — under contrived conditions (counter wrap around, parallel processors) two keys could collide.
**Impact:** Extremely unlikely in practice; theoretical mismatch of pre/post events.
**Suggested fix:** Use a UUID or `crypto.randomUUID()` as the suffix instead of an incrementing counter.

**Implementation steps for Haiku:** In `src/hooks/event-processor.ts:175`, replace `${this.fallbackCounter++}` with `${crypto.randomUUID()}`. Add `import { randomUUID } from 'node:crypto';` at the top. Remove the `fallbackCounter` field at line 44 if no longer used. `npm run build && npx jest -- src/hooks/event-processor.test.ts && npm run lint`.

---

### ~~[F-050] `SessionSpan.end()` has a theoretical double-end race — Low (LIFE) ✅~~
**Location:** `src/tracing/session-span.ts:29-38`
**Issue:** Defensive null check at line 30, then `this.span = null` at line 37. Pure JS single-threaded, so no actual race — but the pattern is fragile if any caller awaits between the check and the null assignment.
**Impact:** None today; future async refactor could break it.
**Suggested fix:** Add a boolean `private ended = false;` and set it at the top of `end()`.

**Implementation steps for Haiku:** In `src/tracing/session-span.ts:29-38`, add `private ended = false;` field. At the top of `end()`, add `if (this.ended) return; this.ended = true;`. `npm run build && npx jest -- src/tracing && npm run lint`.

---

### ~~[F-051] Port `0` is accepted by the parser — Low (CORR) ✅~~
**Location:** `src/index.ts:92-94`
**Issue:** Validation allows `parsed >= 0`, so port `0` (OS-assigned) passes. Logging then refers to the configured value (`0`), not the actual bound port — confusing for diagnostics.
**Impact:** Confusing logs / dashboards if anyone configures port 0.
**Suggested fix:** Reject `parsed === 0` at parse time, or capture the OS-assigned port post-listen and log that.

**Implementation steps for Haiku:** In `src/index.ts:92-94`, change the validation from `parsed >= 0` to `parsed > 0 && parsed <= 65535`. `npm run build && npx jest && npm run lint`.

---

### ~~[F-052] `envBool()` doesn't accept `yes`/`no` or trimmed values — Low (CORR) ✅~~
**Location:** `src/config.ts:128-133`
**Issue:** Only `'true'`, `'1'`, `'false'`, `'0'` are recognized (after lowercasing). Common shell values like `yes`/`no` or values with stray whitespace are silently ignored, falling through to defaults.
**Impact:** Surprises for customers using shell scripts; a misconfigured `NEW_RELIC_AI_MCP_ENABLED='yes'` quietly disables instead of enabling.
**Suggested fix:** Trim, then accept `yes`/`y`/`on` and `no`/`n`/`off` in addition to the current set.

**Implementation steps for Haiku:** In `src/config.ts:128-133` `envBool()`, add `.trim()` before `.toLowerCase()`. Expand the truthy set to `['true', '1', 'yes', 'y', 'on']` and falsy to `['false', '0', 'no', 'n', 'off']`. Add tests for `' true '`, `'YES'`, `'no'`. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-053] `parseArgs` doesn't validate `--log-level` — Low (CORR) ❌
**Location:** `src/index.ts:100`
**Issue:** Cast to `CliOptions['logLevel']` without checking against the allowed values.
**Impact:** `--log-level trace` (or any garbage) is accepted; `createLogger()` may reject it later or silently behave oddly.
**Suggested fix:** Validate against `['debug', 'info', 'warn', 'error']` and throw with a helpful message.

**Verification:** ❌ FALSE POSITIVE — `--log-level` IS validated at runtime via `envLogLevel()` in `config.ts:147` against `['debug','info','warn','error']`.

---

### ~~[F-054] OTLP endpoint URL not scheme-validated at config time — Low (SEC) ✅~~
**Location:** `src/config.ts:447-452`
**Issue:** Default `otlpForwardEndpoint` is `'https://otlp.nr-data.net'`, but customer overrides aren't checked against scheme/format.
**Impact:** A misconfigured `http://` endpoint silently bypasses TLS; hard to spot in logs.
**Suggested fix:** Parse with `new URL(...)`, require `https:`, log if `http:` is used and `transport === 'otlp'`.

**Implementation steps for Haiku:** In `src/config.ts:447-452` (otlpForwardEndpoint resolution), wrap the resolved value in `new URL(...)` and assert `url.protocol === 'https:'` (warn-and-continue for `http:` if running locally; error otherwise). `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### ~~[F-055] Model name not pattern-validated in cost-tools — Low (SEC) ⚠️~~
**Location:** `src/tools/cost-tools.ts:73`
**Issue:** Model name is truncated to 256 chars but not checked against an expected pattern. Special characters could feed log forging or downstream injection.
**Impact:** Low — primarily log-forging or noisy NR events. Truncation already mitigates the worst.
**Suggested fix:** Add a whitelist regex (`/^[a-zA-Z0-9._:-]+$/`) and reject otherwise.

**Implementation steps for Haiku:** In `src/tools/cost-tools.ts:73`, after the truncation, add a regex validation: `if (!/^[a-zA-Z0-9._:-]+$/.test(model)) { return { content: [...], isError: true }; }`. `npm run build && npx jest -- src/tools/cost-tools.test.ts && npm run lint`.

**Verification:** ⚠️ PARTIAL — Truncation to 256 chars (line 73) is the only validation. Pattern validation is genuinely missing, but truncation already mitigates the worst log-forging cases. Treat as a defence-in-depth nit, not a real risk.

---

### [F-056] Logger `JSON.stringify` falls back to `'[unserializable]'` — Low (CORR) ✅ (upstream)
**Location:** `src/shared/logger.ts:42-52` *(fix upstream)*
**Issue:** Circular refs or non-serializable values produce `'[unserializable]'`, losing diagnostic info.
**Impact:** Harder debugging when error objects carry context.
**Suggested fix:** Use a `WeakSet` replacer to handle cycles gracefully, surface field names in the fallback.

**Implementation steps for Haiku:** *(upstream — fix in `nr-ai-typescript-shared`)*. Open `src/logger.ts` upstream. Replace the JSON.stringify with a custom replacer that uses a `WeakSet` to detect cycles and substitute `[Circular: <key>]`. Run `npm run sync:shared` to pull in changes. `npm run build && npx jest && npm run lint`.

---

### [F-057] `accountId` re-parsed without re-validating against config regex — Low (SEC) ❌
**Location:** `src/tools/cross-session-tools.ts:621`
**Issue:** `accountId` is validated as `/^\d{1,12}$/` at config load, but `parseInt()` here doesn't re-validate. If the validation is ever weakened upstream, downstream code accepts it.
**Impact:** Defence-in-depth gap.
**Suggested fix:** Either pass `accountId` as a string and let the GraphQL `Int!` type coerce, or re-run the regex check.

**Implementation steps for Haiku:** In `src/tools/cross-session-tools.ts:621`, before the parseInt, add a sanity regex check: `if (!/^\d{1,12}$/.test(options.accountId)) throw new Error('Invalid accountId');`. `npm run build && npx jest -- src/tools/cross-session-tools.test.ts && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — `accountId` is for an `Int!` GraphQL variable — `parseInt` is appropriate; regex re-check would be redundant.

---

### ~~[F-058] Digest formatter doesn't escape backticks/newlines for Slack — Low (CORR) ✅~~
**Location:** `src/digest/digest-formatter.ts:22`
**Issue:** `topAntiPattern` is wrapped in backticks for Slack code formatting. If the value ever contains backticks or newlines, the Block Kit message breaks.
**Impact:** Malformed Slack message; rare given fixed enum values today.
**Suggested fix:** Escape backticks (`replace(/`/g, "'")`) before wrapping.

**Implementation steps for Haiku:** In `src/digest/digest-formatter.ts:22`, before interpolation, sanitize: `const safeTop = topAntiPattern.replace(/[\`\n]/g, '_');`. Use `safeTop` in the Slack message. `npm run build && npx jest -- src/digest && npm run lint`.

---

### [F-059] Setup wizard doesn't sanitize team/project IDs — Low (CORR) ❌
**Location:** `src/install/setup-wizard.ts:93-99`
**Issue:** Team/project IDs are accepted as any non-empty string. Invalid characters propagate into config and break NRQL queries downstream.
**Impact:** Cryptic NRQL errors at first query attempt.
**Suggested fix:** Apply the same pattern check as `sanitizeOrgField()` (or whatever the canonical sanitizer is).

**Implementation steps for Haiku:** In `src/install/setup-wizard.ts:93-99`, after reading team/project IDs, validate against `/^[a-zA-Z0-9_-]+$/`. Reject invalid input with an inline error message and re-prompt. `npm run build && npx jest -- src/install && npm run lint`.

**Verification:** ❌ FALSE POSITIVE — Setup wizard input is only stored in config, not interpolated into a query/command; sanitization not required for this purpose.

---

### ~~[F-060] Proxy tool name not truncated/sanitized — Low (SEC) ✅~~
**Location:** `src/proxy/proxy-manager.ts:306`
**Issue:** Tool name from `rpc.params?.name` is used as-is in metric dimensions and span attributes.
**Impact:** Oversized or control-character-laden tool names corrupt metrics.
**Suggested fix:** `(typeof rpc.params?.name === 'string' ? rpc.params.name : 'unknown').slice(0, 256).replace(/[\x00-\x1f\x7f]/g, '')`. Per CLAUDE.md, tool names are truncated to 256 chars elsewhere — make this consistent.

**Implementation steps for Haiku:** In `src/proxy/proxy-manager.ts:306`, replace the existing tool-name ternary with the suggested-fix expression above. `npm run build && npx jest -- src/proxy && npm run lint`.

---

~~### [F-061] Empty developer name aggregation key — Low (CORR) ✅~~
~~**Location:** `src/tools/cross-session-tools.ts:680`~~
~~**Issue:** `String(row.developer ?? 'unknown')` substitutes `'unknown'` only for `null`/`undefined`. An empty-string developer becomes the empty-string key, which can collide with other falsy aggregation keys.~~
~~**Impact:** Edge-case mis-aggregation if an event sneaks through with developer === ''.~~
~~**Suggested fix:** `const dev = (row.developer && String(row.developer).trim()) || 'unknown';`~~

~~**Implementation steps for Haiku:** In `src/tools/cross-session-tools.ts:680`, replace `String(row.developer ?? 'unknown')` with `(row.developer && String(row.developer).trim()) || 'unknown'`. `npm run build && npx jest -- src/tools/cross-session-tools.test.ts && npm run lint`.~~

---

~~### [F-062] Big switch in tool handler relies on `break` + post-switch throw — Low (CORR) ✅~~
~~**Location:** `src/tools/session-stats.ts:342-528`~~
~~**Issue:** The switch has no `default`. Several cases use `if (!tracker) break;`. Forgetting a `break` in a future addition silently falls through to the next case.~~
~~**Impact:** Latent bug landing surface for any future contributor.~~
~~**Suggested fix:** Replace `break` with `return { content: [...], isError: true }` per case, and add `default: throw new McpError(...)` after the switch.~~

~~**Implementation steps for Haiku:** In `src/tools/session-stats.ts:342-528`, in each case where `if (!tracker) break;` exists, replace `break` with an explicit `return { content: [{ type: 'text', text: JSON.stringify({ error: '<tracker> not initialised' }) }], isError: true };`. Add `default: throw new Error(\`Unknown tool: ${name}\`);` after the switch. `npm run build && npx jest -- src/tools && npm run lint`.~~

---

### [F-063] `pricing.ts` returns `e as unknown as ModelPricing` — Low (TYPE) ✅ (upstream)
**Location:** `src/shared/pricing.ts:96` *(fix upstream)*
**Issue:** After validating the required fields, the cast bypasses TS structural checks. New required fields added to `ModelPricing` later won't cause compile errors here.
**Impact:** Drift between pricing schema and validation as the schema grows.
**Suggested fix:** Construct a fresh object (`return { inputPerMTok: e.inputPerMTok, outputPerMTok: e.outputPerMTok, ... }`).

**Implementation steps for Haiku:** *(upstream)*. In `src/pricing.ts` upstream, replace `return e as unknown as ModelPricing` with `return { inputPerMTok: e.inputPerMTok, outputPerMTok: e.outputPerMTok, contextWindow: e.contextWindow, ... }`. Run `npm run sync:shared` here. `npm run build && npm run lint`.

---

~~### [F-064] `envBool` doesn't trim before comparing — Low (CORR) ✅~~
~~**Location:** `src/config.ts:128-133`~~
~~**Issue:** Same area as F-052 — env values with leading/trailing whitespace silently fall through to defaults.~~
~~**Impact:** Customer-set env vars from shell quirks (e.g. `' true'`) are silently ignored.~~
~~**Suggested fix:** `process.env[key]?.trim().toLowerCase()` before comparing.~~

~~**Implementation steps for Haiku:** Already covered by F-052 implementation steps. Add `.trim()` to `envBool()` reading. `npm run build && npx jest -- src/config.test.ts && npm run lint`.~~

---

### [F-065] Tool parser `Object.assign` cast hides null-input crash — Low (CORR) ❌
**Location:** `src/hooks/tool-parsers.ts:64-68`
**Issue:** Field parsers cast to `Record<string, unknown>` without checking that `input` is a non-null object. A `null` input crashes the parser with a generic TypeError.
**Impact:** Bad UX if a hook ever sends a `null` input — should be a clear validation error, not a crash.
**Suggested fix:** Guard with `if (typeof input !== 'object' || input === null) continue;` before parsing.

**Verification:** ❌ FALSE POSITIVE — Tool parser already checks `input !== null && input !== undefined && typeof input === 'object'` (lines 191-192) before parsing.

---

~~### [F-066] Test asserts `expect.any(Number)` on timestamps — Low (TEST) ✅~~
~~**Location:** `src/metrics/session-tracker.test.ts:246`~~
~~**Issue:** Asserts `metrics.sessionStartTime` is *any* number — accepts `0`, `NaN`, `Infinity`.~~
~~**Impact:** A bug setting startTime to `0` or `NaN` would pass.~~
~~**Suggested fix:** Bound the assertion: `expect(value).toBeGreaterThan(0); expect(value).toBeLessThan(Date.now() + 1000);`.~~

~~**Implementation steps for Haiku:** In `src/metrics/session-tracker.test.ts:246`, replace `expect(metrics.sessionStartTime).toEqual(expect.any(Number))` with `expect(metrics.sessionStartTime).toBeGreaterThan(0); expect(metrics.sessionStartTime).toBeLessThan(Date.now() + 1000);`. `npx jest -- src/metrics/session-tracker.test.ts`.~~

---

### [F-067] Mocked `MetricAggregator` swallows recordings in EfficiencyScorer test — Low (TEST) ❌
**Location:** `src/metrics/efficiency-score.test.ts:33-50`
**Issue:** The mock is `{ record() {} }`. It doesn't verify that the right metrics are emitted with the right shapes.
**Impact:** A regression in `recordMetric()` (e.g. wrong metric name) wouldn't be caught.
**Suggested fix:** Use `jest.spyOn` on a real or stub aggregator and assert calls/arguments.

**Verification:** ❌ FALSE POSITIVE — `MetricAggregator` is NOT mocked in the EfficiencyScore test; `makeTask()` is a plain factory helper, not a mock.

---

~~### [F-068] Test factory `makeRecord` defaults hide tool-name variability — Low (TEST) ✅~~
~~**Location:** `src/metrics/latency-tracker.test.ts:12-20`~~
~~**Issue:** Default `toolName: 'Read'`, `durationMs: 50`, `success: true`. Tests that don't override these only exercise the happy path.~~
~~**Impact:** Bugs that only manifest under varied input may pass.~~
~~**Suggested fix:** Either require explicit values in tests that care, or randomize defaults using a seedable PRNG.~~

~~**Implementation steps for Haiku:** In `src/metrics/latency-tracker.test.ts:12-20`, in `makeRecord()`, change defaults to required parameters (no default). Update existing call sites to pass explicit values for `toolName`, `durationMs`, `success`. `npx jest -- src/metrics/latency-tracker.test.ts`.~~

---

### [F-069] `AntiPatternType` union has no exhaustiveness assertion — Low (TYPE) ❌
**Location:** `src/metrics/anti-patterns.ts:8-12` and downstream switch sites
**Issue:** The union has 5 members; switch statements over it lack `default: const _: never = x;` exhaustiveness checks. Adding a new pattern type wouldn't cause compile errors at handler sites.
**Impact:** New anti-patterns silently unhandled until runtime.
**Suggested fix:** Add `assertNever` checks at every switch over `AntiPatternType`.

**Verification:** ❌ FALSE POSITIVE — No switch/case over `AntiPatternType` exists in this file that would benefit from `assertNever`. Union type alone needs no exhaustiveness check.

---

### [F-070] Model usage tie-breaking is non-deterministic — Low (CORR) ✅
**Location:** `src/metrics/model-usage-tracker.ts:75`
**Issue:** "Most efficient model" is found via `<` (strict less-than). Two models with identical `costPerOutputToken` produce a result that depends on Map iteration order.
**Impact:** Reports are unstable across runs when costs tie exactly.
**Suggested fix:** Break ties deterministically (e.g. lexicographic by model name).

**Implementation steps for Haiku:** In `src/metrics/model-usage-tracker.ts:75`, change the comparison to: `if (costPerOutputToken < lowestCost || (costPerOutputToken === lowestCost && model < (mostEfficientModel ?? '￿')))`. `npm run build && npx jest -- src/metrics/model-usage-tracker.test.ts && npm run lint`.

---

### [F-071] RecommendationEngine has no `dispose()` method — Low (LIFE) ❌
**Location:** `src/metrics/recommendation-engine.ts:50-75`
**Issue:** Holds references to other trackers and the SessionStore. No teardown clears them. If shutdown happens mid-query, references linger.
**Impact:** Minor; mostly cosmetic.
**Suggested fix:** Add a `dispose()` and call it from the shutdown handler.

**Verification:** ❌ FALSE POSITIVE — RecommendationEngine has no resources to clean up (no event listeners, timers, or file handles); `dispose()` would be a no-op.

---

### [F-072] Weekly summary session window uses `<= end` (inclusive) — Low (CORR) ✅
**Location:** `src/storage/weekly-summary.ts:125-126`
**Issue:** Filter is `s.startTime >= start && s.startTime <= end`, where `end` is set to Sunday 23:59:59.999. A session starting at exactly that millisecond would be classified into the previous week even though Monday 00:00 is the start of the next week.
**Impact:** Edge-case mis-classification on the boundary millisecond.
**Suggested fix:** Use `s.startTime < (end + 1)` or document the inclusive convention prominently.

**Implementation steps for Haiku:** In `src/storage/weekly-summary.ts:125-126`, change `s.startTime <= end.getTime()` to `s.startTime < end.getTime() + 1`. Or simpler: change `<=` to `<` and adjust `end` to be the start of next week (Monday 00:00). `npm run build && npx jest -- src/storage/weekly-summary.test.ts && npm run lint`.

---

### [F-073] Retention boundary slightly off by intent — Low (CORR) ✅
**Location:** `src/storage/retention.ts:9`
**Issue:** Cutoff is `Date.now() - retainDays * 24h`. "Older than `retainDays` days" is `> retainDays * 24h`, but using `>` vs `>=` makes ~1 millisecond difference. Documented behaviour is "delete sessions older than N days"; current implementation matches the strict reading.
**Impact:** Negligible.
**Suggested fix:** Document the boundary semantics in a comment.

**Implementation steps for Haiku:** In `src/storage/retention.ts:9`, add a comment above the cutoff calculation: `// Sessions are deleted if mtime < cutoff. Sessions exactly at the cutoff (rare in practice) are retained.`. No code change. `npm run lint`.

---

## Info / observations

### [F-074] OtlpReceiver `error` listener registered with `on`, not removed on stop — Info (LIFE) ❌
**Location:** `src/proxy/otlp-receiver.ts:27-33`
**Issue:** `server.on('error', errorHandler)` in `start()` has no matching `removeListener` in `stop()`.
**Impact:** Restart-leak; minimal under normal use.
**Suggested fix:** Use `once` or pair with `removeListener` in `stop()`.

**Verification:** ❌ FALSE POSITIVE — OtlpReceiver error listener is implicitly removed when `server.close()` is called in `stop()`; no leak.

---

### [F-075] Session span end-without-start is silently a no-op — Info (LIFE) ✅
**Location:** `src/index.ts:141-146` and `src/tracing/session-span.ts:29-38`
**Issue:** Shutdown handler calls `sessionSpan.end()` unconditionally, but `sessionSpan.start()` only runs when `transport !== 'nr-events-api'`. The defensive null check at `session-span.ts:30` makes this safe today, but it's an implicit contract.
**Impact:** None today; future refactor could break the assumption.
**Suggested fix:** Add an explicit `started: boolean` flag and assert/branch on it; or document the invariant.

**Implementation steps for Haiku:** In `src/tracing/session-span.ts`, add `private started: boolean = false;`. Set it `true` at the end of `start()`. In `end()`, early-return if `!this.started`. `npm run build && npx jest -- src/tracing && npm run lint`.

---

### [F-076] Hook event-processor orphan-timeout uses `>=` boundary — Info (CORR) ✅
**Location:** `src/hooks/event-processor.ts:230`
**Issue:** `now - event.timestamp >= this.orphanTimeoutMs` — fires the moment the timeout has elapsed (correct). The agent flagged this as a possible off-by-one but the comparison is the right one. Listing for completeness.
**Impact:** None.
**Suggested fix:** None needed.

---

## Summary

**Total findings: 76**

| Severity | Count |
|---|---|
| Critical | 0 (after verification — see notes below) |
| High | 14 (F-001 to F-014) |
| Medium | 26 (F-015 to F-040) |
| Low | 33 (F-041 to F-073) |
| Info | 3 (F-074 to F-076) |

### By category

| Code | Description | Count |
|---|---|---|
| **SEC** | Security | 13 |
| **LIFE** | Lifecycle / resources | 13 |
| **CORR** | Correctness / logic | 28 |
| **TYPE** | Type safety / API contracts | 14 |
| **TEST** | Test reliability | 3 |
| **PERF** | Performance | 1 |
| **DOC** | Documentation mismatch | 1 |
| **(upstream)** | Findings in `src/shared/` — fix upstream in `nr-ai-typescript-shared` | 3 |

### Verification notes

Two findings the agents flagged as **Critical** were verified against source and **rejected**:

1. **CostTracker.reset() missing `totalLinesChanged` reset** — verified at `src/metrics/cost-tracker.ts:189`. Already reset. Not a bug.
2. **`persistSession` not awaited** — `SessionStore.saveSession()` uses `writeFileSync` (synchronous), so data persists before shutdown returns. Downgraded the agent's "data is lost" framing.

Per the saved feedback memory `feedback_subagent_audit_verification`, all High-severity findings should be re-verified before being treated as confirmed bugs. Findings flagged ✅ have been spot-checked. Findings flagged 🔍 are agent-reported.

### Recommended next steps

Priority order for remediation:

1. **F-001 (NRQL injection)** — change to GraphQL variables; trivial fix, eliminates a real injection class.
2. **F-002, F-003, F-004, F-005 (file/dir permissions)** — one-line fixes per location; mandated by CLAUDE.md security invariants.
3. **F-006, F-007 (redaction)** — defence-in-depth; the brief positions audit/redaction as compliance-grade, so make it actually airtight.
4. **F-008, F-014 (signal-handler hygiene)** — `process.on` → `process.once` symmetry across HookEventProcessor and HarvestScheduler.
5. **F-011 (percentile inconsistency)** — extract a shared `computePercentile()` helper used by both LatencyTracker and SessionTracker.
6. **F-012, F-013 (NerdGraph response coercion + MCP boundary validation)** — add zod schemas at every external boundary; pattern fix that closes a class of bugs.
7. **Medium severity batch** — pick items that affect the public-facing brief claims (e.g. F-015 highSecurity bypass, F-020 budget alerts going silent, F-034 digest crash on empty week).
8. **Low / Info** — fold into normal cleanup work post-launch.

### Areas not fully covered

The first review pass flagged seven deferred areas. **Pass 2 covered all but one:**

- ✅ Six metric trackers (`trend-analyzer`, `claudemd-tracker`, `prompt-feedback`, `cost-forecast`, `proxy-metrics`, `task-completion-tracker`) — covered in F-077 to F-090
- ✅ `src/install/install-helper.ts` — covered in F-091 to F-094
- ✅ OTLP receiver edge cases — covered in F-095 to F-106
- ✅ Redaction pattern coverage — covered in F-107 to F-116
- ✅ SSRF on IPv6 / DNS rebinding — covered in F-117 to F-124
- ✅ Test coverage gaps — covered in F-125 to F-140

**Still outstanding:**

- **`src/shared/`** — only spot-reviewed. Findings in shared code need to land upstream in `nr-ai-typescript-shared`. Recommend a separate review pass on that repo.

A coverage-percentage report (e.g. `npm run test -- --coverage`) would still surface additional untested critical paths more systematically. The Pass 2 test-gap analysis (F-125 to F-140) is a manual audit and may have missed subtler gaps.

---

# Pass 2 — Coverage of previously-deferred areas

A second sweep was performed covering the 6 metric trackers, `install-helper.ts`, OTLP receiver edge cases, redaction-pattern coverage, IPv6 / DNS-rebind SSRF, and test-coverage gaps. Each new finding was verified against source code by a separate agent. False positives are marked ❌ with the rejection reason.

## Pass 2: Metric trackers

### [F-077] `trend-analyzer.ts` `compareWeeks` swallows null efficiency comparison — Medium (CORR) ✅
**Location:** `src/metrics/trend-analyzer.ts:247-254`
**Issue:** When both weeks lack efficiency data, both `aggA.efficiency` and `aggB.efficiency` are `null`, the `?? 0` coerces to 0, and `percentChange(0, 0)` returns 0. Callers can't distinguish "no change" from "no data".
**Impact:** Trend dashboards show "0% change" when the truthful answer is "insufficient data".
**Suggested fix:** Return `null` (or a tagged `'no-data'` literal) when both inputs were null, instead of coercing to 0.

**Implementation steps for Haiku:** In `src/metrics/trend-analyzer.ts:247-254` `compareWeeks()`, before computing `percentChange()`, check if both `aggA.efficiency` and `aggB.efficiency` are null/undefined; if so, set the result to `null` instead of calling `percentChange(0, 0)`. Update the return type to allow `null`. `npm run build && npx jest -- src/metrics/trend-analyzer.test.ts && npm run lint`.

---

### [F-078] `claudemd-tracker.ts` before/after windows have asymmetric inclusivity — Medium (CORR) ✅
**Location:** `src/metrics/claudemd-tracker.ts:200-203`
**Issue:** `beforeSessions` filter uses `s.startTime < changeTimestamp` (exclusive end) while `afterSessions` uses `s.startTime <= changeTimestamp + windowMs` (inclusive end). Sessions starting exactly at the after-window boundary are counted; sessions exactly at the before-window boundary are not.
**Impact:** CLAUDE.md change-impact analysis is off by one boundary millisecond — clusters of activity at the exact change moment skew the comparison.
**Suggested fix:** Make both sides exclusive (`<`) for symmetry: `s.startTime < changeTimestamp + windowMs` for after.

**Implementation steps for Haiku:** In `src/metrics/claudemd-tracker.ts:200-203`, change `s.startTime <= changeTimestamp + windowMs` to `s.startTime < changeTimestamp + windowMs`. Also keep `s.startTime < changeTimestamp` for before. Both windows now exclusive at the right boundary. `npm run build && npx jest -- src/metrics/claudemd-tracker.test.ts && npm run lint`.

---

### [F-079] `claudemd-tracker.ts` swallows `ENOENT` on missing CLAUDE.md — Low (CORR) ✅
**Location:** `src/metrics/claudemd-tracker.ts:243-248`
**Issue:** `estimateContextCost(filePath)` is wrapped in try/catch that sets `contextTokensForClaudeMd = 0` on any error, including `ENOENT`. A deleted CLAUDE.md and an empty CLAUDE.md report identically.
**Impact:** Misleading metric when the file is genuinely missing — operators can't distinguish "no CLAUDE.md exists" from "CLAUDE.md is small."
**Suggested fix:** Catch and re-throw or return `null` for `ENOENT` specifically; log non-ENOENT errors.

**Implementation steps for Haiku:** In `src/metrics/claudemd-tracker.ts:243-248`, change the catch block to inspect `err.code`. If `err.code === 'ENOENT'`, set `contextTokensForClaudeMd = null`. Otherwise log the error. Update the type of `contextTokensForClaudeMd` to `number | null`. `npm run build && npx jest -- src/metrics/claudemd-tracker.test.ts && npm run lint`.

---

### [F-080] `prompt-feedback.ts` three-way tie tiebreaker is implicit — Low (CORR) ✅
**Location:** `src/metrics/prompt-feedback.ts:199-204`
**Issue:** `if (significant >= moderate && significant >= noise)` always returns `'significant'` on a 1-1-1 tie. Tiebreaker is the implementation order, not documented.
**Impact:** Surprising behaviour; cosmetic but undefendable in a code review.
**Suggested fix:** Document the tiebreaker explicitly, or use weighted voting.

**Implementation steps for Haiku:** In `src/metrics/prompt-feedback.ts:199-204`, above the if-chain add a comment documenting the tiebreaker: `// Tiebreaker: significant > moderate > noise (highest "alarm level" wins on ties).`. Optionally implement weighted voting: `score = 2*significant + 1*moderate + 0*noise`, then label by highest score. `npm run build && npx jest -- src/metrics/prompt-feedback.test.ts && npm run lint`.

---

### [F-081] `cost-forecast.ts` end-of-week math wrong on every non-Sunday day — High (CORR) ⚠️
**Location:** `src/metrics/cost-forecast.ts:38`
**Issue:** `msUntilEndOfWeek = (6 - dayOfWeek) * 86_400_000 + msUntilEndOfDay`. With `getUTCDay()` returning 0 for Sunday, this gives 6 days for Sunday (correct if the week ends on Saturday) but 5 days for Monday, 4 for Tuesday, etc. The week-end definition is inconsistent with the rest of the codebase, which uses ISO weeks (Monday → Sunday).
**Impact:** End-of-week cost forecasts are systematically off by one day for 6 out of 7 days. The numbers shown to users on Tuesday-Saturday under-state expected weekly burn.

**Verification:** ⚠️ PARTIAL — The bug is confirmed but the impact is broader than the original framing. Wrong on all non-Sunday days, not just sometimes.

**Suggested fix:** Use `((7 - dayOfWeek) % 7) * 86_400_000` for an end-of-Saturday week, or align with the ISO week ending on Sunday: `((7 - (dayOfWeek === 0 ? 7 : dayOfWeek)) % 7) * 86_400_000`. Add a unit test for each weekday.

**Implementation steps for Haiku:** In `src/metrics/cost-forecast.ts:38`, replace `(6 - dayOfWeek) * 86_400_000` with the ISO-week formula: `((7 - (dayOfWeek === 0 ? 7 : dayOfWeek)) % 7) * 86_400_000`. Add unit tests using fake timers for each weekday Sunday-Saturday and verify the calculated `msUntilEndOfWeek` is correct. `npm run build && npx jest -- src/metrics/cost-forecast.test.ts && npm run lint`.

---

### [F-082] `proxy-metrics.ts` bounded array exceeds cap by 1 sample — Low (LIFE) ✅
**Location:** `src/metrics/proxy-metrics.ts:269-272`
**Issue:** `appendBounded()` pushes first, then splices when `arr.length > MAX_SAMPLES`. The array transiently holds `MAX_SAMPLES + 1` entries before the splice fires.
**Impact:** Trivial memory overhead; not a true bounded buffer.
**Suggested fix:** Pre-check before push, or use a ring buffer.

**Implementation steps for Haiku:** In `src/metrics/proxy-metrics.ts:269-272`, change the order: check capacity first, splice if needed, then push. Concretely: `if (arr.length >= MAX_SAMPLES) arr.shift(); arr.push(item);`. `npm run build && npx jest -- src/metrics/proxy-metrics.test.ts && npm run lint`.

---

### [F-083] `proxy-metrics.ts` destructuring default doesn't apply for missing pipe-separator — Medium (CORR) ✅
**Location:** `src/metrics/proxy-metrics.ts:202-203`
**Issue:** `const [tool = 'unknown', server = 'unknown'] = key.split('|')`. JS destructuring defaults only apply for missing array elements, not for `undefined`. If `key` lacks a `|`, `server` stays `undefined` instead of becoming `'unknown'`.
**Impact:** Tool-popularity NR events emitted with `server: undefined` — pollutes dashboards.
**Suggested fix:** Explicit handling: `const parts = key.split('|'); const tool = parts[0] ?? 'unknown'; const server = parts[1] ?? 'unknown';`

**Implementation steps for Haiku:** In `src/metrics/proxy-metrics.ts:202-203`, replace `const [tool = 'unknown', server = 'unknown'] = key.split('|')` with `const parts = key.split('|'); const tool = parts[0] || 'unknown'; const server = parts[1] || 'unknown';`. `npm run build && npx jest -- src/metrics/proxy-metrics.test.ts && npm run lint`.

---

### [F-084] `task-completion-tracker.ts` exposes wrong public API surface — High (TYPE) ✅
**Location:** `src/metrics/task-completion-tracker.ts` (no `recordToolCall`)
**Issue:** Per CLAUDE.md, every tracker exposes `recordToolCall(record: ToolCallRecord)`. This tracker exposes only `recordTask()` and `getMetrics()`. Cannot be wired through the standard event-processor pipeline.
**Impact:** Architectural drift — manual data-routing required, easy to forget when adding new trackers; consistency across the metric subsystem is broken.
**Suggested fix:** Add `recordToolCall` (delegating to existing logic where appropriate), or document the deliberate divergence.

**Implementation steps for Haiku:** In `src/metrics/task-completion-tracker.ts`, add a public `recordToolCall(record: ToolCallRecord): void {}` method (no-op or delegate to internal task-tracking). Document at the top of the class: `// Note: this tracker primarily processes via recordTask() which is called externally from TaskDetector. recordToolCall is a no-op for compatibility with the standard tracker pattern.`. `npm run build && npx jest -- src/metrics/task-completion-tracker.test.ts && npm run lint`.

---

### [F-085] `task-completion-tracker.ts` `reset(_sessionId)` ignores parameter while signature suggests session scope — Medium (CORR) ✅
**Location:** `src/metrics/task-completion-tracker.ts:41-42`
**Issue:** Signature accepts `sessionId` (with `_` prefix to suppress lint), but the tracker has no session-scoped state. `reset()` wipes all-time history regardless.
**Impact:** Per-session reset semantics are silently violated — confusing if a user restarts a session and expects only that session to be cleared.
**Suggested fix:** Either remove the parameter or implement session-scoped storage.

**Implementation steps for Haiku:** In `src/metrics/task-completion-tracker.ts:41-42`, either rename `_sessionId` to `sessionId` and add a comment explaining the parameter is reserved for future per-session resets, OR remove the parameter entirely (and update callers). Pick whichever is consistent with other trackers. `npm run build && npx jest -- src/metrics/task-completion-tracker.test.ts && npm run lint`.

---

### [F-086] `prompt-feedback.ts` accesses `s.toolBreakdown.X` without verifying `toolBreakdown` is defined — Low (TYPE) ❌
**Location:** `src/metrics/prompt-feedback.ts:104, 114`
**Issue:** Original concern: code reads `s.toolBreakdown.Read` and `s.toolBreakdown.EnterPlanMode` without guarding `s.toolBreakdown` itself.

**Verification:** ❌ FALSE POSITIVE — `FullSessionSummary.toolBreakdown` is typed as a required `Record<string, number>` field, not optional. Type system guarantees it exists. The agent's "potential crash" claim is not realisable through type-correct code paths.

---

### [F-087] `claudemd-tracker.ts` buffer eviction adjusts emitted-index with floor at zero — Medium (CORR) ✅
**Location:** `src/metrics/claudemd-tracker.ts:270-273`
**Issue:** Eviction calls `splice(0, dropped)` then `lastEmittedIndex = Math.max(0, lastEmittedIndex - dropped)`. Combined with the post-push check, the math can cause unemitted-since pointers to slide forward incorrectly under pathological eviction patterns.
**Impact:** Edge-case double-emission or skipped emission of CLAUDE.md change events; harder to detect in practice.
**Suggested fix:** Add a unit test exercising buffer overflow with non-emitted entries; convert to a documented invariant if behaviour is intentional.

**Implementation steps for Haiku:** In `src/metrics/claudemd-tracker.test.ts`, add a test that fills `changes` past `MAX_CHANGES`, verifies `splice(0, dropped)` evicts oldest, and `lastEmittedIndex` adjusts correctly so no emission gap or duplication occurs. `npm run build && npx jest -- src/metrics/claudemd-tracker.test.ts && npm run lint`.

---

### [F-088] `prompt-feedback.ts` correction-rate inversion is fragile — Low (CORR) ✅
**Location:** `src/metrics/prompt-feedback.ts:228-231`
**Issue:** Code computes `(1 - correctionRate) * 100` to show "correction percentage" and triggers a recommendation when `1 - correctionRate > 0.3`. The double-inversion (rate stored as success-fraction, then inverted to correction-fraction) is not documented and easy to mis-read.
**Impact:** Future contributors may misinterpret the variable; recommendations could fire on wrong conditions if anyone "fixes" the inversion.
**Suggested fix:** Rename the dimension to its actual semantic meaning (e.g. `successFraction` or `correctionFraction`); add a comment.

**Implementation steps for Haiku:** In `src/metrics/prompt-feedback.ts:228-231`, add a comment above the inversion: `// correctionRate is stored as success-fraction (1.0 = no corrections, 0.0 = all corrections). The (1 - correctionRate) inversion gives the actual correction fraction.`. Optionally rename the field in `dimensions` to `successFraction` for clarity. `npm run build && npx jest -- src/metrics/prompt-feedback.test.ts && npm run lint`.

---

### [F-089] `cost-forecast.ts` `<= 0` guard rejects legitimate near-zero elapsed time — Low (CORR) ✅
**Location:** `src/metrics/cost-forecast.ts:17-27`
**Issue:** Early-return on `elapsedMs <= 0 || spentUsd <= 0`. A barely-started session with `elapsedMs == 0` or one that spent exactly $0 returns no forecast.
**Impact:** Cosmetic — forecast UI shows "—" for the first few ms of a session.
**Suggested fix:** Use `elapsedMs < 1` and treat `spentUsd < epsilon` as "no spend" rather than "no data".

**Implementation steps for Haiku:** In `src/metrics/cost-forecast.ts:17-27`, change `elapsedMs <= 0 || spentUsd <= 0` to `elapsedMs < 1`. Treat `spentUsd === 0` as "session running, nothing spent" (return zero forecasts) rather than "no data". `npm run build && npx jest -- src/metrics/cost-forecast.test.ts && npm run lint`.

---

### [F-090] `trend-analyzer.ts` `getPreviousWeekId` may return a same-week id around DST or year boundaries — Low (CORR) ✅
**Location:** `src/metrics/trend-analyzer.ts:418-420`
**Issue:** Subtracts 1 day from week start. If `getWeekDateRange()` returns a Sunday (instead of the ISO Monday), DST forward-jumps could mean "minus 24h" lands inside the same ISO week. Verified: code is correct under standard ISO assumptions, but fragile if assumptions ever change.
**Impact:** Edge case at year-boundary or DST week — week-over-week comparisons could repeat data.
**Suggested fix:** Compute previous week deterministically by subtracting 7 days from the start, then re-deriving the week id.

**Implementation steps for Haiku:** In `src/metrics/trend-analyzer.ts:418-420` `getPreviousWeekId()`, change `subtract 1 day` to `subtract 7 days`: `const prev = new Date(start.getTime() - 7 * 86400000); return getIsoWeekId(prev);`. `npm run build && npx jest -- src/metrics/trend-analyzer.test.ts && npm run lint`.

---

## Pass 2: install-helper.ts

### [F-091] `install/cli.ts` `writeJsonFile` is non-atomic — High (LIFE) ✅
**Location:** `src/install/cli.ts:41-46`
**Issue:** `writeFileSync()` writes directly to the destination path. A crash mid-write leaves a half-written JSON file, which `readJsonFile()` (line 35) then silently parses as `{}`, losing the user's existing settings (hooks, MCP servers).
**Impact:** Silent data loss on crash during install/uninstall — user's existing Claude Code settings are wiped.
**Suggested fix:** Standard temp-file-then-rename pattern: write to `<path>.tmp`, then `renameSync()` atomically. Wrap in try/finally to clean up the temp file on failure.

**Implementation steps for Haiku:** In `src/install/cli.ts:41-46` `writeJsonFile`, replace direct `writeFileSync(path, ...)` with: write to `<path>.tmp` first, then `renameSync(path + '.tmp', path)`. Wrap in try/finally that calls `unlinkSync(path + '.tmp')` if the temp file still exists on error. `npm run build && npx jest -- src/install && npm run lint`.

---

### [F-092] Uninstall makes destructive edits without backup — Medium (LIFE) ✅
**Location:** `src/install/cli.ts:95-119` (uninstall handler)
**Issue:** No backup is created before `removeSettings()` / `removeMcpConfig()` modifies user files in place. A regression in the removal logic or a hand-edited config file could destroy user settings without any recovery path.
**Impact:** Permanent loss of customer Claude Code configuration on a buggy uninstall.
**Suggested fix:** Save a `<path>.backup-<timestamp>` copy before any destructive write. Document where backups live.

**Implementation steps for Haiku:** In `src/install/cli.ts:95-119` (uninstall), before calling `removeSettings`/`removeMcpConfig`, save backup copies: `copyFileSync(path, path + '.backup-' + Date.now())`. Log the backup path so the user knows where to recover from. `npm run build && npx jest -- src/install && npm run lint`.

---

### [F-093] `install-helper.ts` resolves paths without symlink protection — Low (SEC) ✅
**Location:** `src/install/install-helper.ts:75-87`
**Issue:** `detectSettingsPath` / `detectMcpConfigPath` resolve paths via `resolve()` but never call `realpathSync()`. A symlink at `~/.claude/` pointing to a sensitive directory would cause writes to land in the symlink target.
**Impact:** Low practical risk because symlink installation requires existing system compromise, but defence-in-depth is missing.
**Suggested fix:** `realpathSync(dirname(path))` and verify the resolved parent is under `$HOME` (or the project root) before writing.

**Implementation steps for Haiku:** In `src/install/install-helper.ts:75-87`, after path resolution, call `realpathSync(dirname(path))` and verify the result starts with `homedir()` or the project root. Throw if it doesn't. `npm run build && npx jest -- src/install && npm run lint`.

---

### [F-094] `mergeSettings` accepts JSON without schema validation — Low (TYPE) ✅
**Location:** `src/install/install-helper.ts:133-156`
**Issue:** The merge code only checks `typeof result.hooks === 'object'`. A file where `hooks` is the wrong shape (e.g. an array, or string-valued sub-keys) is silently overwritten.
**Impact:** Partial corruption of user-customised settings if the existing file has been hand-edited into an unexpected shape.
**Suggested fix:** Validate the existing config against a zod schema before merging. Refuse and surface a clear error if it doesn't match.

**Implementation steps for Haiku:** In `src/install/install-helper.ts:133-156`, define a `SettingsSchema` zod schema covering the expected `hooks` shape. Run `safeParse` before merging; on failure, throw with a clear "existing settings file has unexpected shape — fix manually" message. `npm run build && npx jest -- src/install && npm run lint`.

---

*(F-002 / F-003 already cover the file-permission gaps in `install/cli.ts:43-46`. The agent re-flagged them; not duplicated here.)*

*(Two install-helper findings rejected after verification: the duplicate-hook concern was already deduplicated by `hasNrObserveCommand()`, and `removeSettings()` does delete empty hook objects rather than leaving `{}` behind.)*

---

## Pass 2: OTLP receiver edge cases

### [F-095] OTLP receiver has no max body-size limit — Critical (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:71-78` (readBody)
**Issue:** `readBody()` accumulates chunks in an array without any size cap. A malicious or buggy client can stream gigabytes of data, exhausting memory.
**Impact:** Trivial OOM denial-of-service against the OTLP receiver — single request takes the process down.
**Suggested fix:** Track accumulated bytes; reject with HTTP 413 above a configurable cap (e.g. 10 MiB, mirroring `proxy-manager.ts:DEFAULT_MAX_BODY_BYTES`).

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts:71-78` `readBody`, add `let totalBytes = 0; const MAX_BODY_BYTES = 10 * 1024 * 1024;`. On each `data` chunk, `totalBytes += chunk.length;` and reject with `res.statusCode = 413; res.end()` if exceeded. Add `maxBodyBytes` to `OtlpReceiverOptions` (default 10 MiB). `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-096] OTLP receiver binds to `0.0.0.0` by default — Critical (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts` (constructor + `listen()` call)
**Issue:** `OtlpReceiverOptions` interface has no `bindAddress` field. `this.server.listen(this.options.port, ...)` defaults to `0.0.0.0`, exposing the receiver on every network interface. CLAUDE.md explicitly identifies 0.0.0.0 binding as risky.
**Impact:** Any client on the network (potentially the public internet, depending on customer firewall) can post arbitrary OTLP payloads. Telemetry poisoning, reflected DDoS, or — combined with F-095 — remote OOM.
**Suggested fix:** Add `bindAddress: string = '127.0.0.1'` to the options. Pass it to `listen()`.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts`, add `bindAddress?: string` (default `'127.0.0.1'`) to `OtlpReceiverOptions`. Pass `this.options.bindAddress ?? '127.0.0.1'` as the second argument to `this.server.listen(port, host, ...)`. Add a config flag `otlpReceiverBindAddress` in `src/config.ts`. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-097] OTLP receiver has no slow-loris timeout — High (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:71-78`
**Issue:** No request timeout configured. A slow-loris attacker can hold connections open indefinitely by drip-feeding bytes, exhausting connection slots.
**Impact:** Denial of service via socket exhaustion.
**Suggested fix:** `req.setTimeout(30000)` in `handleRequest`, or use a server-level idle timeout. Reject with HTTP 408 on expiry.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts` `handleRequest`, add `req.setTimeout(30000, () => { res.statusCode = 408; res.end(); req.destroy(); });` at the top. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-098] OTLP receiver does not handle gzip/deflate `Content-Encoding` — High (CORR) ✅
**Location:** `src/proxy/otlp-receiver.ts:71-78`
**Issue:** `readBody()` reads raw bytes only. If the client sends `Content-Encoding: gzip`, the buffer holds compressed bytes, JSON parsing fails silently (`enrichPayload` line 80-92), and compressed bytes are forwarded with the original `Content-Encoding` header to upstream.
**Impact:** Compressed OTLP payloads from real-world OTel SDKs are dropped or forwarded as unreadable data. This is a normal use case the receiver currently breaks.
**Suggested fix:** Inspect `Content-Encoding`; pipe through `zlib.createGunzip()` / `createInflate()` before parsing. Reject unsupported encodings with HTTP 415.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts`, before `readBody`, inspect `req.headers['content-encoding']`. If `gzip`, pipe through `zlib.createGunzip()`. If `deflate`, `zlib.createInflate()`. If `br`, `zlib.createBrotliDecompress()`. Otherwise reject with `res.statusCode = 415; res.end();`. `npm install zlib` if needed (it's a Node builtin). `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-099] OTLP receiver has no rate limiting — High (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts` (entire class)
**Issue:** No per-IP or global rate limit. Combined with F-096 (public bind) this is a flood-attack waiting to happen.
**Impact:** Denial of service; upstream NR ingest also DoSed via the forwarding step.
**Suggested fix:** Add a simple sliding-window rate limiter keyed on remote address. Reject with HTTP 429 over the configured threshold.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts`, add a private `Map<string, number[]>` keyed by `req.socket.remoteAddress`. On each request, prune entries older than 60s and check count. If > N (e.g. 100), reject with `res.statusCode = 429`. Otherwise push current timestamp and continue. Add `rateLimitPerMinute: number = 100` to `OtlpReceiverOptions`. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-100] OTLP receiver has no authentication on inbound requests — Medium (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:43-49`
**Issue:** Any caller that can reach the bind address can post telemetry. No bearer token, mTLS, shared secret, or other identity check.
**Impact:** Telemetry poisoning by any reachable client. With F-096 (public bind) this is severe.
**Suggested fix:** Optional `apiKey` field in `OtlpReceiverOptions`; validate `Authorization: Bearer <key>` header when set.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts`, add `apiKey?: string` to `OtlpReceiverOptions`. In `handleRequest`, if `this.options.apiKey` is set, check `req.headers.authorization === \`Bearer ${this.options.apiKey}\``. Reject with `res.statusCode = 401; res.end();` if mismatched. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-101] OTLP receiver does not validate `Content-Type` strictly — Medium (CORR) ✅
**Location:** `src/proxy/otlp-receiver.ts:80-92` (enrichPayload)
**Issue:** Header is read but never checked against an allowlist. A request claiming `application/x-protobuf` with JSON body, or vice versa, is silently passed through.
**Impact:** Garbage in, garbage out — silently corrupted telemetry forwarded upstream.
**Suggested fix:** Validate against `['application/json', 'application/x-protobuf', 'application/octet-stream']`. Reject with HTTP 415 otherwise.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts:80-92` (or in `handleRequest` before calling `enrichPayload`), check `req.headers['content-type']` against the allowlist `['application/json', 'application/x-protobuf', 'application/octet-stream']`. Reject with `res.statusCode = 415; res.end();` if not in the list. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-102] OTLP receiver `readBody` resolves on partial reads — Medium (CORR) ✅
**Location:** `src/proxy/otlp-receiver.ts:71-78`
**Issue:** Promise resolves on the `end` event without verifying that the full expected body was received. If the client drops mid-stream, an `end` may still fire after a partial read, and the partial buffer is forwarded to enrichment.
**Impact:** Truncated OTLP payloads silently forwarded to upstream as if complete.
**Suggested fix:** Track bytes-received vs `Content-Length`; on `end` if shorter than expected, reject with HTTP 400. Subscribe to `aborted` event explicitly.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts:71-78`, when `Content-Length` header is present, track `expectedBytes = Number(req.headers['content-length'])` and `receivedBytes`. On `end`, if `receivedBytes < expectedBytes`, reject the promise. Also subscribe `req.on('aborted', () => reject(new Error('Request aborted')));`. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-103] OTLP receiver error handler logs full `err` object — Medium (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:64-68`
**Issue:** `logger.error('OTLP error', { err })` — full error object including stack and any captured context is written to logs. If logs are world-readable or shipped to less-secure sinks, internal paths and structures leak.
**Impact:** Information disclosure via logs.
**Suggested fix:** Log only `String(err)` and the message; if a stack is needed, route to a separate debug-only sink.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts:64-68`, replace `logger.error('OTLP error', { err })` with `logger.error('OTLP receiver error', { message: err instanceof Error ? err.message : String(err) })`. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-104] OTLP receiver does not handle `Expect: 100-continue` — Low (CORR) ✅
**Location:** `src/proxy/otlp-receiver.ts` (handleRequest)
**Issue:** Node's HTTP server requires explicit `res.writeContinue()` for `Expect: 100-continue` clients. Without handling, a conformant client waits for the 100 response and times out.
**Impact:** Compatibility break with HTTP/1.1-strict OTel exporters; minor connection holding.
**Suggested fix:** Add a `'continue'` listener or globally disable expect-continue.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts` `handleRequest`, after creating the server, add a `'checkContinue'` event listener: `this.server.on('checkContinue', (req, res) => { res.writeContinue(); this.handleRequest(req, res); });`. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

### [F-105] OTLP receiver method check correctness — Info (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:43-49`
**Issue:** Per agent verification, the method/path check (`req.method !== 'POST' || !req.url?.startsWith('/v1/')`) is correct and rejects with 404. Listed for completeness — this is a *correct* pattern.
**Impact:** None.
**Suggested fix:** None needed.

---

### [F-106] OTLP receiver forwarder strips client headers correctly — Info (SEC) ✅
**Location:** `src/proxy/otlp-receiver.ts:120-127`
**Issue:** `forward()` only sends `forwardHeaders` from options + the derived `Content-Type`; client headers are deliberately not propagated. This is the correct security posture (avoids header injection from clients into the upstream NR API call).
**Impact:** None — current behaviour is correct.
**Suggested fix:** Add a comment / test asserting this invariant so a future refactor doesn't accidentally pass client headers through.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.ts:120-127`, add a comment above the `forward()` headers block: `// SECURITY: client request headers are deliberately NOT propagated to upstream — only forwardHeaders + Content-Type. Do not change without security review.`. In `src/proxy/otlp-receiver.test.ts`, add a test asserting that a client header like `X-Custom: leak` does NOT appear in the forwarded fetch call's headers. `npm run build && npx jest -- src/proxy/otlp-receiver.test.ts && npm run lint`.

---

*(One OTLP finding rejected: O7 claimed the body was decompressed and the encoding header passed through, creating a mismatch — but the body is never actually decompressed; the issue is folded into F-098.)*

---

## Pass 2: Redaction pattern coverage (`DEFAULT_REDACTION_PATTERNS` in `src/config.ts`)

### [F-107] Missing pattern: GitHub App installation tokens (`ghs_`) — High (SEC) ✅
**Location:** `src/config.ts:67`
**Issue:** Pattern 2 alternation has `ghp_`, `gho_`, `github_pat_`, `xoxb-`, `xoxp-`, `Bearer `, and `sk-`, but not `ghs_` (GitHub App installation tokens, format `ghs_[A-Za-z0-9]{36}`).
**Impact:** GitHub App installation tokens emitted to logs / NR events grant the leaker the App's installation permissions until rotated.
**Suggested fix:** Add `ghs_` to the alternation, or a dedicated pattern `/\bghs_[A-Za-z0-9]{36}\b/g`.

**Implementation steps for Haiku:** In `src/config.ts:67`, modify the Pattern 2 alternation to include `ghs_`. Add tests for `ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` redaction. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-108] Missing pattern: Stripe live/test/restricted keys (`sk_live_`, `sk_test_`, `rk_live_`) — High (SEC) ✅
**Location:** `src/config.ts:67`
**Issue:** Pattern 2 only catches OpenAI's hyphen-prefixed `sk-`. Stripe keys use underscores: `sk_live_…`, `sk_test_…`, `rk_live_…`.
**Impact:** Stripe live keys leaked through logs / events allow unauthorised charges on the customer's Stripe account.
**Suggested fix:** Add `/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g` to the pattern set.

**Implementation steps for Haiku:** In `src/config.ts`, append `/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g` to `DEFAULT_REDACTION_PATTERNS`. Add tests covering Stripe key formats. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-109] Missing pattern: PyPI API tokens (`pypi-...`) — Medium (SEC) ✅
**Location:** `src/config.ts` (DEFAULT_REDACTION_PATTERNS)
**Issue:** No pattern matches PyPI's `pypi-AgEIc…` token format.
**Impact:** PyPI tokens in logs allow attackers to publish malicious packages under the user's account.
**Suggested fix:** Add `/\bpypi-[A-Za-z0-9_-]{20,}\b/g`.

**Implementation steps for Haiku:** In `src/config.ts`, append `/\bpypi-[A-Za-z0-9_-]{20,}\b/g` to `DEFAULT_REDACTION_PATTERNS`. Add a test for PyPI token format. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-110] Missing pattern: Hugging Face tokens (`hf_...`) — Medium (SEC) ✅
**Location:** `src/config.ts`
**Issue:** No pattern catches Hugging Face tokens (`hf_[A-Za-z0-9]{30+}`).
**Impact:** HF tokens in logs allow API abuse against the user's HF account.
**Suggested fix:** Add `/\bhf_[A-Za-z0-9]{30,}\b/g`.

**Implementation steps for Haiku:** In `src/config.ts`, append `/\bhf_[A-Za-z0-9]{30,}\b/g`. Add a test for HF token format. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-111] Missing pattern: database connection strings with embedded credentials — High (SEC) ✅
**Location:** `src/config.ts`
**Issue:** No pattern catches `postgres://user:pass@host/db`, `mongodb+srv://user:pass@cluster.mongodb.net`, `mysql://user:pass@host`, etc.
**Impact:** Database credentials embedded in connection strings (a very common pattern) leak verbatim into logs and NR events.
**Suggested fix:** Add `/(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:\/\s]+:[^\@\/\s]+@[^\s\/]+/gi`.

**Implementation steps for Haiku:** In `src/config.ts`, append `/(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:\/\s]+:[^\@\/\s]+@[^\s\/]+/gi`. Test with `postgres://user:secret@db.example.com/mydb`. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-112] Missing pattern: HTTP basic-auth credentials in URLs — High (SEC) ✅
**Location:** `src/config.ts`
**Issue:** `https://user:password@host/path` URLs (RFC-3986 userinfo) are not redacted.
**Impact:** Plain-text credentials in URLs leak verbatim.
**Suggested fix:** Add `/https?:\/\/[^\s:\/]+:[^\s@\/]+@[^\s\/]+/gi`.

**Implementation steps for Haiku:** In `src/config.ts`, append `/https?:\/\/[^\s:\/]+:[^\s@\/]+@[^\s\/]+/gi`. Test with `https://user:password@host/`. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-113] Missing pattern: Twilio SIDs / API keys (`AC...`, `SK...`) — Medium (SEC) ✅
**Location:** `src/config.ts`
**Issue:** No Twilio Account-SID / API-key pattern.
**Impact:** Twilio credentials in logs allow SMS/voice abuse on the customer's account.
**Suggested fix:** Add `/\b(?:AC|SK)[a-f0-9]{32}\b/g`.

**Implementation steps for Haiku:** In `src/config.ts`, append `/\b(?:AC|SK)[a-f0-9]{32}\b/g`. Test with Twilio AC SID format. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-114] Pattern 2 ends with greedy `\S+` — Low (SEC) ✅
**Location:** `src/config.ts:67`
**Issue:** Pattern 2 is `/(?:sk-|ghp_|...|Bearer\s+)\S+/g`. The trailing `\S+` is unbounded and consumes everything until the next whitespace.
**Impact:** Over-redaction: anything textually adjacent to a token (without whitespace) gets eaten too. Could redact non-secret text in malformed log lines, making debugging harder.
**Suggested fix:** Bound the suffix to the token format: `[A-Za-z0-9_-]{20,200}` instead of `\S+`. Use length-specific suffixes per token prefix when known.

**Implementation steps for Haiku:** In `src/config.ts:67`, replace the trailing `\S+` in Pattern 2 with `[A-Za-z0-9_-]{20,200}`. Add tests for over-redaction edge cases. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-115] Missing pattern: Azure SAS query parameters — Medium (SEC) ✅
**Location:** `src/config.ts`
**Issue:** Azure storage SAS tokens appear as URL query parameters (`?sv=…&sig=…&se=…`) that grant temporary access.
**Impact:** SAS tokens in logs allow attackers to access Azure blobs / queues until expiry.
**Suggested fix:** Add `/(?:[?&])(?:sig|se|sp|srt|ss|sv|st)=[A-Za-z0-9%_-]+/gi`.

**Implementation steps for Haiku:** In `src/config.ts`, append the Azure SAS pattern. Test with a SAS URL containing `?sv=2021-06-08&ss=bfqt&srt=sco&sig=...`. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

### [F-116] Missing patterns: Vercel / Heroku / Cloudflare / Datadog / NPM / etc — Medium (SEC) ✅
**Location:** `src/config.ts`
**Issue:** Several common platform-token formats are unpatterned. NPM (`npm_…`) is partially covered by Pattern 7, but Vercel, Heroku, Cloudflare, Datadog, PagerDuty, etc. have no specific patterns.
**Impact:** Tokens for any of these platforms leak verbatim.
**Suggested fix:** Either add a generic catch-all (`/\b(?:vercel_|heroku_|dd_|pk_)[A-Za-z0-9_-]{20,}\b/gi`) or one pattern per provider — pick whichever is more maintainable.

**Implementation steps for Haiku:** In `src/config.ts`, append `/\b(?:vercel_|heroku_|dd_|pk_)[A-Za-z0-9_-]{20,}\b/gi` to cover Vercel/Heroku/Datadog/Cloudflare in one pattern. Add tests covering each format. `npm run build && npx jest -- src/config.test.ts && npm run lint`.

---

## Pass 2: SSRF gaps (`src/security/ssrf.ts`)

### [F-117] No IPv6 unspecified `::` and IPv4-mapped loopback `::ffff:127.0.0.1` blocks — High (SEC) ✅
**Location:** `src/security/ssrf.ts:6` (`BLOCKED_HOST_RE`)
**Issue:** Regex blocks `[::1]` (loopback) but not `::` (unspecified) or IPv4-mapped IPv6 forms of loopback (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`).
**Impact:** SSRF bypass to localhost via the IPv6 family.
**Suggested fix:** Block IPv6 unspecified, IPv4-mapped variants, and any 4-in-6 representation that resolves to a blocked IPv4.

**Implementation steps for Haiku:** In `src/security/ssrf.ts:6`, expand `BLOCKED_HOST_RE` to include `::` (unspecified), `::ffff:127.0.0.1`, and IPv4-mapped patterns. Or rewrite to parse the host as an IP using `net.isIPv6()` / `net.isIPv4()` and check ranges via a CIDR library like `ip-cidr`. Add tests for `[::]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-118] No IPv6 ULA (`fc00::/7`, `fd00::/8`) or link-local (`fe80::/10`) blocks — High (SEC) ✅
**Location:** `src/security/ssrf.ts:6`
**Issue:** No regex pattern matches IPv6 unique-local or link-local prefixes. These are the IPv6 equivalents of RFC-1918 private space.
**Impact:** SSRF bypass to internal IPv6-only services.
**Suggested fix:** Add patterns matching `fc..:`, `fd..:`, `fe[89ab].:` prefixes (case-insensitive). Better: parse the host as an IP and check membership against canonical CIDR ranges.

**Implementation steps for Haiku:** In `src/security/ssrf.ts:6`, add to `BLOCKED_HOST_RE`: `\[?(?:fc[0-9a-f]{2}|fd[0-9a-f]{2}|fe[89ab][0-9a-f])` patterns. Or recommended: install `ip-cidr` or use `net.isIP()` and explicit CIDR checks for `fc00::/7`, `fe80::/10`. Add tests for each blocked range. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-119] No handling of IPv4-mapped IPv6 to RFC-1918 (`::ffff:10.0.0.1`) — High (SEC) ✅
**Location:** `src/security/ssrf.ts:6`
**Issue:** A request to `http://[::ffff:10.0.0.1]/` reaches the RFC-1918 IPv4 host but the IPv4 regex doesn't fire because the hostname is the IPv6 form.
**Impact:** Bypass of all RFC-1918 IPv4 protections.
**Suggested fix:** Detect `::ffff:x.x.x.x` (and the bare-hex form `::ffff:0a00:0001`), extract the embedded IPv4, and validate as IPv4.

**Implementation steps for Haiku:** In `src/security/ssrf.ts`, add a function `extractIPv4FromMappedIPv6(host: string): string | null` that parses `::ffff:x.x.x.x` (and hex `::ffff:0a00:0001`) and returns the underlying IPv4. Run the IPv4 validation on the extracted address. Add tests for `[::ffff:10.0.0.1]`, `[::ffff:0a00:0001]`. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-120] DNS rebinding window — validation in constructor, fetch later — High (SEC) ✅
**Location:** `src/proxy/upstream-http.ts:59-66`
**Issue:** `validateSsrfUrl` runs once in the constructor, with whatever the host resolved to at that moment. The actual `fetch` happens later in `forward()` (line ~103). DNS records can change in between (TTL expiry; deliberate DNS rebinding).
**Impact:** Classic DNS rebinding: attacker registers a domain that resolves to a public IP at validation time and to `127.0.0.1` at fetch time. Internal-network exfiltration.
**Suggested fix:** Resolve the host once, pin to the resulting IP, and connect to that IP (re-validating it against the SSRF block list). Or re-validate immediately before each fetch.

**Implementation steps for Haiku:** In `src/proxy/upstream-http.ts:59-66`, after the constructor's `validateSsrfUrl()`, resolve the hostname via `dns.lookup()` and pin to the resolved IP. In `forward()`, connect to that IP directly using a custom http(s).Agent that overrides `lookup`. Re-validate the IP against SSRF rules before each fetch. Add tests using a DNS mock that returns different IPs on consecutive calls. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-121] No explicit blocks for cloud metadata FQDNs — Medium (SEC) ✅
**Location:** `src/security/ssrf.ts:6`
**Issue:** AWS metadata IP `169.254.169.254` is caught by the link-local block, but GCP's `metadata.google.internal` and Azure's `metadata.azure.com` are public DNS names that resolve to internal addresses inside the cloud account.
**Impact:** SSRF on GCP/Azure can reach the metadata service and exfiltrate credentials.
**Suggested fix:** Block these FQDNs explicitly.

**Implementation steps for Haiku:** In `src/security/ssrf.ts:6`, add a separate FQDN allowlist check: reject hosts matching `metadata.google.internal`, `metadata.azure.com`, `100.100.100.200` (Alibaba), or any other known cloud-metadata endpoints. Add tests for each. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-122] Decimal / octal / hex IP encodings not normalised — Low (SEC) ✅
**Location:** `src/security/ssrf.ts:6`
**Issue:** Regex operates on `url.hostname` directly. Node's URL parser does normalise some IP encodings, but exotic forms (`http://2130706433/`, `http://0177.0.0.1/`) may not be fully canonicalised. Worth defending in depth.
**Impact:** Potential SSRF bypass via non-standard IP encodings.
**Suggested fix:** Parse the hostname through Node's `dns.lookup()` or `net.isIP()` after attempting normalisation; reject anything that doesn't fit canonical decimal-dotted form.

**Implementation steps for Haiku:** In `src/security/ssrf.ts`, before the regex check, if the hostname looks numeric (no letters except `:`/`.`/`x`), pass it through `dns.lookup()` to canonicalise. Reject if the canonical form is in any blocked range. Add tests for `http://2130706433/` (decimal `127.0.0.1`), `http://0177.0.0.1/`, and `http://0x7f.0.0.1/`. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-123] Trailing-dot hostname bypass — Low (SEC) ✅
**Location:** `src/security/ssrf.ts:6`
**Issue:** Node's URL parser keeps a trailing dot in `url.hostname` (`localhost.` instead of `localhost`). The regex anchors on `localhost$`, so the dot escapes the match.
**Impact:** SSRF bypass via `http://localhost./`, `http://127.0.0.1./`.
**Suggested fix:** Strip a trailing dot before regex test, or include `\.?$` in the regex anchors.

**Implementation steps for Haiku:** In `src/security/ssrf.ts`, before the regex check, strip a trailing dot from `url.hostname`: `const host = url.hostname.replace(/\.$/, '');`. Use `host` in the regex test. Add a test for `http://localhost./` and `http://127.0.0.1./`. `npm run build && npx jest -- src/proxy/upstream-http.test.ts && npm run lint`.

---

### [F-124] Userinfo bypass safe but undocumented — Info (SEC) ✅
**Location:** `src/security/ssrf.ts:9-19`
**Issue:** `http://safe.example.com@evil.com/` is correctly rejected because `url.hostname` returns `evil.com` (Node's URL parser strips userinfo). This is a *correct* current behaviour — listed because the agent flagged it for documentation.
**Impact:** None.
**Suggested fix:** Add a test asserting this invariant so a future refactor doesn't accidentally use `url.host` (which includes userinfo).

**Implementation steps for Haiku:** In `src/proxy/upstream-http.test.ts` (or wherever the SSRF tests live), add a test: `it('rejects http://safe@evil.com/ — userinfo bypass attempt')` asserting `validateSsrfUrl` checks against `evil.com`, not the userinfo. `npx jest -- src/proxy/upstream-http.test.ts`.

---

## Pass 2: Test coverage gaps

### [F-125] No end-to-end test that redaction is applied to emitted NR events — Critical (TEST) ✅
**Location:** `src/server.test.ts` (gap), `src/transport/nr-ingest.test.ts`
**Issue:** `redactSensitive` has unit tests in `config.test.ts` but no integration test pipes a tool call carrying realistic secret-bearing input through the full hook → event → ingest path and asserts the emitted NR event has `[REDACTED]` (not the secret).
**Impact:** A regression that bypasses redaction in any single intermediate layer would slip past the unit tests; secrets reach NR dashboards.
**Suggested fix:** Add an integration test using the NR ingest mock: record a tool call with a secret in input/output, drain, assert no secret in the serialised payload.

**Implementation steps for Haiku:** Create `src/server.integration.test.ts` (or extend an existing integration test). Use the existing NR ingest mock from `src/transport/nr-ingest.test.ts`. Construct a tool call record where `inputContent` contains `Bearer abc123def456...` and `command` contains a basic-auth URL. Run the full event-processor → harvest pipeline, assert each emitted event payload contains `[REDACTED]` (not the original secret). `npm run build && npx jest -- src/server.integration.test.ts && npm run lint`.

---

### [F-126] No test that `highSecurity=true` actually scrubs content from emitted events — Critical (TEST) ✅
**Location:** `src/server.test.ts` / `src/transport/nr-ingest.test.ts`
**Issue:** `config.test.ts` proves `highSecurity` flips `recordContent` to `false`, but no test asserts that the emitted NR event payload contains zero content fields when high-security mode is active.
**Impact:** Customer-facing high-security claim isn't end-to-end enforced in tests; a future regression silently breaks compliance.
**Suggested fix:** Add a test: enable high-security, record content-bearing tool calls, drain, assert no `input_content` / `output_content` / `tool_input` keys present anywhere in the emitted event JSON.

**Implementation steps for Haiku:** In `src/server.integration.test.ts` (or a new file `src/server.high-security.test.ts`), construct a `McpServerConfig` with `highSecurity: true`. Build the full event-processor with that config. Record content-bearing tool calls, drain, assert: no key named `input_content`, `output_content`, `tool_input`, or `inputContent` exists in the serialised payload (use `JSON.stringify(payload).includes('input_content')` as a sanity check). `npm run build && npx jest -- src/server.high-security.test.ts && npm run lint`.

---

### [F-127] No tests for `LocalStore.drainBuffer` failure modes — High (TEST) ✅
**Location:** `src/storage/local-store.test.ts`
**Issue:** Existing tests cover happy path + orphaned `.drain` recovery + malformed lines. Missing: `readFileSync` throws on the `.drain` file; `unlinkSync` fails after read; concurrent append during rename; very large buffers.
**Impact:** Real-world drain failures (disk full, permission flips, EROFS) are untested. Could leak `.drain` files indefinitely or repeatedly emit the same events.
**Suggested fix:** Add fault-injection tests: mock fs operations to throw on specific calls, assert recovery / retry behaviour.

**Implementation steps for Haiku:** In `src/storage/local-store.test.ts`, add tests using `jest.spyOn(fs, 'readFileSync')` and `jest.spyOn(fs, 'unlinkSync')` to throw on the `.drain` file specifically. Assert: drain doesn't lose events; `.drain` retry on next poll; large buffer (>1MB) handles correctly. `npx jest -- src/storage/local-store.test.ts`.

---

### [F-128] No test for `HarvestScheduler` retry-buffer flush during shutdown — High (TEST) ✅
**Location:** `src/shared/harvest/harvest-scheduler.test.ts`
**Issue:** Tests cover idempotent stop and concurrent stop. Missing: scenario where a send fails, events go into the retry buffer, `stop()` is called before the next harvest tick, and the final flush should drain the retry buffer.
**Impact:** Re-queued events on shutdown could be silently lost without a test catching the regression.
**Suggested fix:** Mock the upstream to fail on first send, then succeed; verify events delivered exactly once across the failed-send + retry-flush cycle.

**Implementation steps for Haiku:** In `src/shared/harvest/harvest-scheduler.test.ts`, add a test: mock the upstream `send` to fail on first call (events go into retry buffer), then call `stop()` immediately. Verify the upstream `send` is called a second time with the buffered events during shutdown flush. `npx jest -- src/shared/harvest/harvest-scheduler.test.ts`.

---

### [F-129] No tests for HookEventProcessor pre-event duplication or out-of-order arrivals — High (TEST) ✅
**Location:** `src/hooks/event-processor.test.ts`
**Issue:** Missing edge cases: duplicate pre-events with the same `toolUseId`; post-event arriving before pre; fallback-counter collisions when two orphan posts arrive at the same `tool:timestamp`.
**Impact:** Real-world hook event ordering can be unpredictable; regressions in pairing logic would not be caught.
**Suggested fix:** Add tests for duplicate pre, pre-after-post, and timestamp collision cases. Assert each emitted record has a unique session-scoped ID.

**Implementation steps for Haiku:** In `src/hooks/event-processor.test.ts`, add tests for: (1) two pre events with same `toolUseId` (should overwrite), (2) post event arriving before pre event (should orphan), (3) two posts arriving for the same `tool:timestamp` without `toolUseId` (fallback collision — should produce unique records). Assert each emitted `ToolCallRecord` has a unique session-scoped ID. `npx jest -- src/hooks/event-processor.test.ts`.

---

### [F-130] No SSRF coverage for IPv6 link-local / multi-range boundary tests — High (TEST) ✅
**Location:** `src/proxy/upstream-http.test.ts`
**Issue:** Existing tests spot-check one IP per range. Missing: explicit boundaries (10.0.0.0 / 10.255.255.255 / 11.0.0.0; 172.15.255.255 / 172.16.0.0 / 172.32.0.0; etc.), IPv6 link-local (`[fe80::1]`), multicast (`224.0.0.0`), `allowPrivateHosts=true` opt-out path, and DNS hostnames that resolve to private IPs.
**Impact:** SSRF regressions could land without firing tests.
**Suggested fix:** Parameterise the SSRF test with all RFC-1918 boundaries; add IPv6 link-local and multicast cases (links to F-117 to F-119).

**Implementation steps for Haiku:** In `src/proxy/upstream-http.test.ts`, parameterise SSRF tests with `it.each([...])` covering: 10.0.0.0/255.255.255.255 boundaries; 172.15.255.255 (just outside) / 172.16.0.0 (just inside) / 172.31.255.255 (just inside) / 172.32.0.0 (just outside); 192.168.0.0/192.168.255.255; 169.254.0.0/169.254.255.255; multicast 224.0.0.0–239.255.255.255; IPv6 `[::]`, `[::1]`, `[fe80::1]`, `[fc00::1]`, `[::ffff:10.0.0.1]`. Verify each is rejected. `npx jest -- src/proxy/upstream-http.test.ts`.

---

### [F-131] No tests for NR ingest retry-classification logic — High (TEST) ✅
**Location:** `src/transport/nr-ingest.test.ts`
**Issue:** Tests cover the basic re-queue path and shutdown flush, but not error classification: 400 should not retry, 429 / 503 should retry, 500 with body containing a non-retryable code should not retry, max-retry limit enforcement, `Retry-After` header respect.
**Impact:** Silent infinite retry loops on permanent errors, or premature drops on transient errors.
**Suggested fix:** Mock specific HTTP error responses and assert the classification + retry budget behaviour for each.

**Implementation steps for Haiku:** In `src/transport/nr-ingest.test.ts`, add tests covering: (1) HTTP 400 → no retry, batch dropped; (2) HTTP 429 → retry up to max-retry-limit; (3) HTTP 503 → retry; (4) `Retry-After: 30` header → schedule next retry 30s later; (5) After max retries (e.g. 3), drop the batch with a warning log. Use `nock` or fetch-mock to simulate responses. `npx jest -- src/transport/nr-ingest.test.ts`.

---

### [F-132] No `SessionStore` corruption-recovery tests — Medium (TEST) ✅
**Location:** `src/storage/session-store.test.ts`
**Issue:** No tests for malformed JSON in a session file, empty/whitespace-only file, permission errors during save, or concurrent saves to the same session id.
**Impact:** Crashes or silent data loss on disk corruption could escape testing.
**Suggested fix:** Add fault-injection tests covering each case and assert graceful fallback + log emission.

**Implementation steps for Haiku:** In `src/storage/session-store.test.ts`, add tests: (1) malformed JSON in session file → `loadSession` returns `null` and logs warning; (2) empty/whitespace-only file → returns `null`; (3) `writeFileSync` throws permission error → `saveSession` logs and continues without crashing; (4) two `saveSession` calls for the same id → last-write-wins, no corruption. `npx jest -- src/storage/session-store.test.ts`.

---

### [F-133] No `retention.purgeOldSessions` interruption / TOCTOU tests — Medium (TEST) ✅
**Location:** `src/storage/retention.test.ts`
**Issue:** Existing tests cover happy path and boundary days. Missing: file mtime modified between stat and unlink; unlink failing on a subset of files (assert remaining files retried next sweep); permission flip mid-purge.
**Impact:** Subtle TOCTOU bugs land without test coverage.
**Suggested fix:** Add fs-mock tests injecting timing variations.

**Implementation steps for Haiku:** In `src/storage/retention.test.ts`, add tests: (1) mock `statSync` to return one mtime, then mock `unlinkSync` to throw on the first file → assert remaining files retried next sweep; (2) mock the directory permission to flip mid-purge; (3) mtime modified between stat and unlink. `npx jest -- src/storage/retention.test.ts`.

---

### [F-134] No negative tests for MCP tool input validation — Medium (TEST) ✅
**Location:** `src/tools/*.test.ts`
**Issue:** Tool handler tests cover valid inputs but lack negative cases: negative token counts, out-of-range `weeks` (`-1`, `999`), invalid `since` strings, invalid enum values for `quality`, missing required fields.
**Impact:** Bad input may corrupt metrics silently; the existing "happy path" tests don't catch this class of bug.
**Suggested fix:** For each MCP tool, add 2-3 negative test cases asserting that handlers either reject or sanitise gracefully (no NaN propagation, no crash).

**Implementation steps for Haiku:** In each `src/tools/*.test.ts`, add negative tests: (1) negative numbers where positive expected (`tokens: -100`, `weeks: -1`); (2) out-of-range values (`weeks: 999`); (3) malformed dates (`since: "yesterday"`); (4) invalid enums (`quality: 'great'`); (5) missing required fields. Each should produce `isError: true` or a sanitised default — never NaN, never crash. `npx jest -- src/tools`.

---

### [F-135] No tests for cost calculation edge cases — Medium (TEST) ✅
**Location:** `src/metrics/cost-tracker.test.ts`
**Issue:** Tests cover basic accumulation but miss: unknown model name fallback, cache-read-token cost ratio (typically 10% of input), cache-creation cost (typically same as input), multi-model session aggregation, fallback char-based estimation when self-reported tokens are absent.
**Impact:** Cost reports can be wrong by orders of magnitude on cache-heavy or multi-model sessions without tests catching it.
**Suggested fix:** Add a parameterised test matrix covering each pricing-table feature.

**Implementation steps for Haiku:** In `src/metrics/cost-tracker.test.ts`, add tests: (1) unknown model name (e.g. `'fictional-model-9000'`) → graceful fallback (zero cost or a default rate, not crash); (2) cache-read tokens cost is 10% of input rate; (3) cache-creation tokens cost equal to input; (4) multi-model session with 3 different models — verify `costByModel` map is correct; (5) char-based estimation when self-reported tokens are absent. `npx jest -- src/metrics/cost-tracker.test.ts`.

---

### [F-136] No threshold-boundary tests for anti-pattern detection — Medium (TEST) ✅
**Location:** `src/metrics/anti-patterns.test.ts`
**Issue:** Tests cover threshold "n+ events" but not the `n-1` (should-not-fire) and `n+1` (should-fire) boundary tests for each pattern. Also missing: thrashing where edits target different files in alternation; over-delegation at exactly the agent threshold.
**Impact:** Off-by-one regressions in detection thresholds slip past.
**Suggested fix:** Parameterised tests for threshold-1 / threshold / threshold+1 for each of the 5 pattern types.

**Implementation steps for Haiku:** In `src/metrics/anti-patterns.test.ts`, for each of the 5 pattern types (thrashing, re-reading, stuck-loop, blind-editing, over-delegation), add three test cases: at threshold-1 (no fire), at threshold (fire), at threshold+1 (fire). Also test thrashing on alternating files (should not fire). `npx jest -- src/metrics/anti-patterns.test.ts`.

---

### [F-137] No tests for CLI argument-parsing edge cases — Low (TEST) ✅
**Location:** `src/index.test.ts`
**Issue:** `--help`, unknown flags, conflicting `--stdio` + `--port`, malformed numeric arguments (`--port=abc`, `--port=99999`, `--port=-1`), config file paths with spaces — none have tests.
**Impact:** CLI footguns slip through to launch.
**Suggested fix:** Add parametrised tests for each malformed-input case.

**Implementation steps for Haiku:** In `src/index.test.ts`, add tests: (1) `--help` returns early and exits cleanly; (2) `--unknown-flag` rejected with error; (3) `--stdio --port 8080` together — assert behaviour is documented (one wins, or error); (4) `--port=abc` / `--port=99999` / `--port=-1` rejected; (5) config file path with spaces handled. `npx jest -- src/index.test.ts`.

---

### [F-138] No setup-wizard idempotency or env-detection tests — Medium (TEST) ✅
**Location:** `src/install/setup-wizard.test.ts`
**Issue:** Tests cover `buildConfig` field merging. Missing: re-running wizard with an existing config file preserves user edits; env vars (`NEW_RELIC_LICENSE_KEY`, etc.) auto-populate prompts; cancellation (Ctrl+C / SIGINT) leaves config untouched; existing-but-malformed config file doesn't crash the wizard.
**Impact:** Re-running the wizard could quietly destroy user customisations.
**Suggested fix:** Add tests for each scenario; mock readline to inject responses / cancellation.

**Implementation steps for Haiku:** In `src/install/setup-wizard.test.ts`, add tests: (1) re-run wizard with existing config → unrelated fields preserved; (2) `NEW_RELIC_LICENSE_KEY` env var → auto-populates the prompt; (3) Ctrl+C / SIGINT during wizard → config untouched; (4) malformed existing config → wizard shows clear error and offers to start fresh. Mock the readline-based prompts to inject responses. `npx jest -- src/install/setup-wizard.test.ts`.

---

### [F-139] No OTLP receiver size-limit / encoding / timeout tests — Medium (TEST) ✅
**Location:** `src/proxy/otlp-receiver.test.ts`
**Issue:** Tests cover happy-path enrichment, JSON / protobuf round-trip, and 404 responses. Missing: payloads above the (currently absent — see F-095) max body size; gzip-encoded payloads; mismatched `Content-Type`; slow-loris timeouts; aborted streams.
**Impact:** All the OTLP findings (F-095 to F-104) lack regression tests; even after fixing them, regressions wouldn't be caught.
**Suggested fix:** Add tests in lockstep with the F-095 to F-104 fixes.

**Implementation steps for Haiku:** In `src/proxy/otlp-receiver.test.ts`, add tests for each F-095 to F-104 fix: (1) > 10 MiB body → 413; (2) `Content-Encoding: gzip` body decompressed; (3) `Content-Type: text/html` rejected with 415; (4) slow stream → 408 timeout; (5) abort mid-stream → 400; (6) missing `Authorization` header when `apiKey` is configured → 401. `npx jest -- src/proxy/otlp-receiver.test.ts`.

---

### [F-140] Audit-trail false-positive / case-variation tests are spot-checked, not exhaustive — Medium (TEST) ✅
**Location:** `src/security/audit-trail.test.ts`
**Issue:** Tests cover the obvious destructive patterns. Missing: case variations (`RM -rf`), spacing variations (`rm -r -f`), file paths that contain destructive substrings (`/var/log/rm-rf-backup.tar`), Bash commands carrying secrets that should be redacted in the audit record.
**Impact:** Real-world commands miss detection or false-positive on innocent paths.
**Suggested fix:** Parameterised tests covering case, spacing, embedded-substring scenarios; explicit secret-redaction assertion.

**Implementation steps for Haiku:** In `src/security/audit-trail.test.ts`, add tests: (1) case variations `'RM -rf /'`, `'Rm -RF /'`; (2) spacing variations `'rm -r -f /'`, `'rm  -rf  /'`; (3) embedded-substring `'/var/log/rm-rf-backup.tar'` (should NOT trigger); (4) Bash command `'curl -H "Authorization: Bearer abc123" ...'` — assert audit record's `command` field is redacted. `npx jest -- src/security/audit-trail.test.ts`.
