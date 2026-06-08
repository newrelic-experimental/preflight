# Release Audit — Pre-Open-Source Review

**Scope:** Flat single-package repo (`src/`); shared code in `src/shared/` (read-only mirror from `nr-ai-typescript-shared`)
**Original audit:** 2026-05-06
**Re-audited:** 2026-06-03 — updated for monorepo breakup, product rename, resolved findings removed
**Reviewed by:** Claude Code (automated multi-agent analysis + manual code verification)

---

## Executive Summary

The codebase is well-structured and security-conscious, with zero committed secrets, comprehensive input validation, and strong documentation. The main blockers before open-sourcing are administrative (missing LICENSE, CODE_OF_CONDUCT.md) rather than deep technical problems. Several medium-priority bugs also need attention.

---

## CRITICAL — Must Fix Before Publishing

### C1. No LICENSE File

**Severity:** CRITICAL
**File:** missing at repo root

No `LICENSE` file exists. Without a license, the project is legally closed-source by default — contributors cannot fork, and users cannot legally run derived works. This blocks open-source publication entirely.

**Action:** Add a `LICENSE` file at the repo root. MIT or Apache 2.0 are both appropriate for a CLI/SDK tool. Also add a `"license"` field to `package.json`.

---

### C2. Real Credentials on Disk in test-app/.env

**Severity:** CRITICAL
**File:** `packages/test-app/.env` _(now in `nr-ai-typescript-agent` repo)_

The file contained credentials matching the format of real New Relic keys. The file is NOT in git history (`.gitignore` is correctly configured), so this is not a historical leak. However, these keys must be rotated before either repo is made public.

**Status:** Rotation was due at original audit time (2026-05-06). Confirm the three keys (license key, account ID, user API key) have been rotated in the New Relic console and replaced with `your-license-key-here`-style placeholders. This action is in the `nr-ai-typescript-agent` repo.

---

### ✅ C3. Internal New Relic URL — Resolved

**File:** `docs/ONBOARDING.md` (deleted)

`source.datanerd.us/commune/npm-setup` was present in ONBOARDING.md. That file has been deleted and replaced by `CONTRIBUTING.md`, which contains no internal links. No action required.

---

## HIGH — Should Fix Before Publishing

### H1. Missing CODE_OF_CONDUCT.md

**Severity:** HIGH
**File:** not present at repo root

`CONTRIBUTING.md` has been created. `CODE_OF_CONDUCT.md` is still missing. GitHub prominently surfaces this file and it is expected by many automated contributor workflows.

**Action:** Create `CODE_OF_CONDUCT.md`. The [Contributor Covenant](https://www.contributor-covenant.org/) is the standard template.

---

### H2. Missing package.json Metadata Fields

**Severity:** HIGH
**File:** `package.json`

Published npm packages should include:

- `"license"`: not set
- `"engines"`: README mentions Node.js v24 as a requirement, but nothing enforces this at install time
- `"repository"`: npm registry won't link to the source repo without this

**Action:** Add to `package.json`:

```json
"license": "MIT",
"engines": { "node": ">=24.0.0" },
"repository": {
  "type": "git",
  "url": "https://github.com/<org>/nr-ai-coding-observability"
}
```

---

## MEDIUM — Recommended Before Publishing

### M1. Pricing Calculation: Negative Cache Savings Possible

**Severity:** MEDIUM
**File:** `src/shared/pricing.ts`

The cache savings calculation (`inputRate - cacheReadRate`) can produce a negative number if a custom pricing entry is loaded where `cacheReadPerMTok > inputPerMTok`. Each rate is validated as `>= 0` individually but the relative ordering is not enforced.

```typescript
// savings = tokensToUsd(tokens, inputPerMTok - cacheReadPerMTok)
// If cacheReadPerMTok > inputPerMTok → negative savings reported
```

**Action:** Add validation on custom pricing load to assert `cacheReadPerMTok <= inputPerMTok` and `cacheWritePerMTok <= inputPerMTok`, with a clear error message.

---

### M2. CostPerOutcome: Bug-Fix Classification False Negatives

**Severity:** MEDIUM
**File:** `src/metrics/cost-per-outcome.ts`

The sequential logic requires an Edit/Write tool call to appear immediately after a test failure is detected. If a non-edit tool (e.g., `Bash` grep, `Read`) is invoked between the test failure and the fix, `sawEditAfterFailure` is never set and the task is misclassified as `failed_attempt` instead of `bug_fix`.

Example sequence that is misclassified:

```
test_fail → grep (Bash) → edit (Write) → test_pass  ← classified as failed_attempt
```

**Action:** Change `sawEditAfterFailure` to be set when any Edit/Write tool is called after a test failure, regardless of intervening tools.

---

### M3. Hardcoded NerdGraph URL in Multiple Source Files

**Severity:** MEDIUM (low security risk, but low flexibility)
**Files:**

- `src/tools/cross-session-tools.ts:31–33`
- `scripts/deploy-alerts.ts:42`
- `scripts/deploy-dashboard.ts:44`

```typescript
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';
```

This is a public endpoint (not a secret). The deploy scripts do include `--eu` and `--staging` flags that override the URL at runtime, which partially mitigates the issue. However, `cross-session-tools.ts` has its own inline URL constants that don't share this override path.

**Action:** Centralize the region-aware URL logic in one place and import it from `src/tools/cross-session-tools.ts` rather than duplicating the constants.

---

## LOW — Minor Issues

### L1. Anti-Pattern Detection: Interrupted Consecutive Call Chain

**Severity:** LOW
**File:** `src/metrics/anti-patterns.ts`

A non-Bash tool resets `consecutiveCount`, so a pattern of `Bash(cmd) → Read → Bash(cmd)` is not detected as a repeat. The anti-pattern is real but the detector misses cases where other tools interleave. Low impact since this is a heuristic.

---

### L2. Staging API Endpoints Exposed in Source

**Severity:** LOW (informational)
**File:** `src/shared/transport/http-client.ts`

The code references `staging-insights-collector.newrelic.com`, `staging-metric-api.newrelic.com`, and `staging-log-api.newrelic.com`. These are public-facing NR staging endpoints (not internal hostnames) used when a staging license key is detected. No action required, but external contributors will see that the project was developed against NR's staging environment.

---

### L3. Node.js v24 Mentioned in README Without Enforcement

**Severity:** LOW
**File:** `README.md`

The README lists `Node.js >= 24` as a system requirement, but the `engines` field is missing from `package.json` (see H2). The requirement is stated but not enforced at install time.

---

## NOT CONFIRMED — Rejected After Code Review

### LocalStore.drainBuffer() Race Condition (FALSE POSITIVE)

The agent claimed data loss was possible during concurrent writes. The code at `src/storage/local-store.ts` uses `renameSync(bufferPath, tmpPath)`, which is atomic on POSIX. Any `appendFileSync` calls that arrive after the rename write to a new `buffer.jsonl`, picked up on the next poll cycle. No data is lost. The recovery block correctly handles a crash mid-drain. Design is sound.

### HarvestScheduler Signal Handler Leak (FALSE POSITIVE)

The agent claimed `process.once()` listeners would accumulate on multiple `start()` calls. The `start()` method has an early-return guard (`if (this.running) return`) and stores handlers as bound constructor properties (`this.boundBeforeExit`, `this.boundSigterm`). `doStop()` calls `process.removeListener` using the same references. No leak exists.

### ESLint 10 / Jest 30 Pre-release Concern (FALSE POSITIVE)

Originally flagged as potentially unstable pre-release versions. As of 2026-06-03 both are stable: ESLint `10.4.1` and Jest `30.4.2` are shipping production releases. No action needed.

---

## Open-Source Readiness Checklist

| Item                                  | Status       | Notes                                                                              |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| LICENSE file                          | ❌ Missing   | Must add before publish                                                            |
| No committed secrets                  | ✅ Clean     | `.env` not in git history                                                          |
| Rotate disk credentials               | ⚠️ Confirm   | `test-app/.env` (in `nr-ai-typescript-agent` repo) — confirm keys were rotated     |
| Internal URLs removed                 | ✅ Resolved  | `docs/ONBOARDING.md` deleted; `CONTRIBUTING.md` has no internal links              |
| CONTRIBUTING.md                       | ✅ Created   |                                                                                    |
| CODE_OF_CONDUCT.md                    | ❌ Missing   |                                                                                    |
| npm scope                             | ✅ N/A       | Shared code is synced as source, not a published package; scope claim not required |
| `license` field in package.json       | ❌ Missing   |                                                                                    |
| `engines` field in package.json       | ❌ Missing   |                                                                                    |
| `repository` field in package.json    | ❌ Missing   | Use `nr-ai-coding-observability` repo name                                         |
| Workspace wildcard deps               | ✅ Resolved  | Flat repo — no workspaces                                                          |
| README quality                        | ✅ Excellent | Comprehensive                                                                      |
| Security practices                    | ✅ Strong    | Redaction, input validation, audit trail                                           |
| Test coverage                         | ✅ Good      | Co-located tests, clear patterns                                                   |
| Dashboard/alert JSON clean            | ✅ Clean     | No account-specific data                                                           |
| No private registry references (code) | ✅ Clean     | All deps on public npm                                                             |
| No postinstall hooks                  | ✅ Safe      |                                                                                    |
| GitHub Actions                        | ✅ Portable  | No internal CI references                                                          |

---

## Recommended Pre-Release Order

1. Add `LICENSE` (30 min)
2. Confirm credential rotation in `nr-ai-typescript-agent` repo's `test-app/.env` (15 min)
3. Add `license`, `engines`, and `repository` fields to `package.json` (10 min)
4. Create `CODE_OF_CONDUCT.md` (30 min)
5. Fix `CostPerOutcome` bug-fix classifier (M2) (1 hr)
6. Fix pricing negative savings validation (M1) (30 min)
7. Address remaining medium/low items at discretion
