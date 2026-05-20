# Release Audit — Pre-Open-Source Review

**Scope:** Full monorepo with focus on `packages/nr-ai-mcp-server` and `packages/shared`  
**Date:** 2026-05-06  
**Reviewed by:** Claude Code (automated multi-agent analysis + manual code verification)

---

## Executive Summary

The codebase is well-structured and security-conscious, with zero committed secrets, comprehensive input validation, and strong documentation. The main blockers before open-sourcing are administrative (missing LICENSE, CONTRIBUTING.md, internal URL in ONBOARDING.md) rather than deep technical problems. Several medium-priority bugs and dependency hygiene issues also need attention.

---

## CRITICAL — Must Fix Before Publishing

### C1. No LICENSE File

**Severity:** CRITICAL  
**File:** missing at repo root

No `LICENSE` file exists. Without a license, the project is legally closed-source by default — contributors cannot fork, and users cannot legally run derived works. This blocks open-source publication entirely.

**Action:** Add a `LICENSE` file at the repo root. MIT or Apache 2.0 are both appropriate for a CLI/SDK tool. Also add a `"license"` field to every `package.json`.

---

### C2. Real Credentials on Disk in test-app/.env

**Severity:** CRITICAL  
**File:** `packages/test-app/.env` *(now in `nr-ai-typescript-agent` repo)*

The file contains credentials that match the format of real New Relic keys:

```
NEW_RELIC_LICENSE_KEY=175cae4b092eb97939c793977b4834609441NRAL
NEW_RELIC_ACCOUNT_ID=908482
NEW_RELIC_USER_KEY=NRAK-GQ4L32QSWNTQ6D8Y150NWB8IP5L
```

**The file is NOT in git history** (`.gitignore` is correctly configured), so this is not a historical leak. However, these keys must be rotated before the repo is made public — any accident (force-add, wrong `.gitignore` removal, branch merge) could expose them. The keys themselves should be treated as compromised since they were read during this review.

**Actions:**
1. Rotate all three keys in the New Relic console immediately
2. Replace values in `.env` with `your-license-key-here`-style placeholders (matching the `.env.example` pattern already in place)
3. Verify `.gitignore` keeps `.env` excluded on all package paths

---

### C3. Internal New Relic URL in ONBOARDING.md

**Severity:** CRITICAL  
**File:** `ONBOARDING.md:27`

```
- Access to New Relic's private npm registry ([setup guide](https://source.datanerd.us/commune/npm-setup))
```

`source.datanerd.us` is an internal New Relic GitHub Enterprise instance. External contributors cannot access this URL and it should not appear in a public repo.

**Action:** Remove this line. All project dependencies are on the public npm registry. If an onboarding prerequisite applies only to NR employees, move it to an internal wiki.

---

## HIGH — Should Fix Before Publishing

### H1. Missing CONTRIBUTING.md and CODE_OF_CONDUCT.md

**Severity:** HIGH  
**Files:** neither file exists at repo root

GitHub prominently surfaces both files. Their absence signals an incomplete open-source project. The `CODE_OF_CONDUCT.md` in particular is expected by many automated checks and contributor workflows.

**Action:** Create both files. For `CONTRIBUTING.md`, cover bug reporting, PR workflow, commit message conventions (already in `CLAUDE.md`), and development setup. For `CODE_OF_CONDUCT.md`, the [Contributor Covenant](https://www.contributor-covenant.org/) is the standard template.

---

### H2. @nr-ai-observatory npm Scope Not Verified

**Severity:** HIGH  
**File:** `packages/shared/package.json`

The internal shared package is scoped as `@nr-ai-observatory/shared`. Publishing requires either owning the `@nr-ai-observatory` npm organization or renaming the package. If another party registers this scope first, the package cannot be published.

**Action:** Before publishing, run `npm view @nr-ai-observatory` to check if the org exists and is owned by you/your team. If not, register the org, or rename the package to `nr-ai-observatory-shared` (unscoped). Also add `"publishConfig": { "access": "public" }` to the scoped package's `package.json`.

---

### H3. Wildcard Workspace Dependencies Must Change Before npm Publish

**Severity:** HIGH  
**Files:** `packages/nr-ai-mcp-server/package.json` (and `nr-ai-typescript-agent` packages, `nr-ai-github-tools` packages, and `nr-ai-typescript-shared/package.json` if publishing those separately)

```json
"@nr-ai-observatory/shared": "*"
"nr-ai-agent": "*"
```

*(`nr-ai-agent` is now in the `nr-ai-typescript-agent` repo — this pattern applies there too)*

Wildcard `*` resolves to the local workspace package during development, but when published to npm `*` means "any version including future breaking majors." npm workspaces do not preserve the workspace: protocol in the published tarball unless `"publishConfig"` is configured.

**Action:** Change all internal workspace references to `"workspace:*"` (npm workspaces convention, resolved to the local path during development and a concrete semver on publish) or to an explicit initial version range like `"^0.1.0"`.

---

### H4. Missing package.json Metadata Fields

**Severity:** HIGH  
**Files:** All `package.json` files

Published npm packages should include:
- `"license"`: not set on any package
- `"engines"`: README mentions Node.js v24 as a requirement, but nothing enforces this at install time
- `"repository"`: npm registry won't link to the source repo without this

**Action:** Add to the root and all publishable packages:

```json
"license": "MIT",
"engines": { "node": ">=18.0.0" },
"repository": {
  "type": "git",
  "url": "https://github.com/<org>/nr-ai-observatory"
}
```

---

## MEDIUM — Recommended Before Publishing

### M1. nr-ai-agent: SDK Clients in devDependencies Alongside peerDependencies *(nr-ai-agent now in `nr-ai-typescript-agent` repo)*

**Severity:** MEDIUM  
**File:** `packages/nr-ai-agent/package.json` *(now in `nr-ai-typescript-agent` repo)*

All six SDK clients (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `@aws-sdk/client-bedrock-runtime`, `@mistralai/mistralai`, `cohere-ai`) are listed in **both** `devDependencies` and `peerDependencies`. This is intentional for local testing but is confusing for contributors — the README doesn't explain why. More importantly, `peerDependenciesMeta.optional: true` is the right mechanism and it is already configured correctly.

**Action:** Add a comment in `package.json` or a `README.md` note explaining the dual listing pattern, or move dev-time SDKs to a dedicated workspace test package to avoid confusion.

---

### M2. Unbounded peerDependency Ranges

**Severity:** MEDIUM  
**File:** `packages/nr-ai-agent/package.json` *(now in `nr-ai-typescript-agent` repo)*

All peerDependencies use `>=X.Y.Z` with no upper bound:

```json
"@anthropic-ai/sdk": ">=0.20.0",
"openai": ">=4.0.0"
```

This permits any future major version (e.g., `@anthropic-ai/sdk@99.0.0`) even if it ships breaking API changes the wrappers don't handle.

**Action:** Tighten to semver caret ranges matching the development version:

```json
"@anthropic-ai/sdk": ">=0.20.0 <2.0.0",
"openai": ">=4.0.0 <6.0.0"
```

---

### M3. Root package.json Specifies Unusual Tool Versions

**Severity:** MEDIUM  
**File:** `package.json` (root)

```json
"eslint": "^10.2.0",
"jest": "^30.3.0",
"@types/jest": "^30.0.0"
```

ESLint 10 and Jest 30 are not stable releases as of this writing. These may be pre-release or non-existent versions. The lock file pins whatever npm resolved them to, but a fresh `npm install` (e.g., in CI without a cache) could fail or pull unexpected versions.

**Action:** Verify these versions exist as stable releases on npm: `npm view eslint@10 version` and `npm view jest@30 version`. If they do not exist, correct to the latest stable equivalents (`eslint@^9`, `jest@^29`, `@types/jest@^29`).

---

### M4. Pricing Calculation: Negative Cache Savings Possible

**Severity:** MEDIUM  
**File:** `packages/shared/src/pricing.ts`

The cache savings calculation (`inputRate - cacheReadRate`) can produce a negative number if a custom pricing entry is loaded where `cacheReadPerMTok > inputPerMTok`. Each rate is validated as `>= 0` individually but the relative ordering is not enforced.

```typescript
// savings = tokensToUsd(tokens, inputPerMTok - cacheReadPerMTok)
// If cacheReadPerMTok > inputPerMTok → negative savings reported
```

**Action:** Add validation on custom pricing load to assert `cacheReadPerMTok <= inputPerMTok` and `cacheWritePerMTok <= inputPerMTok`, with a clear error message.

---

### M5. CostPerOutcome: Bug-Fix Classification False Negatives

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts`, approx. lines 103–172

The sequential logic requires an Edit/Write tool call to appear after a test failure is detected. If a non-edit tool (e.g., `Bash` grep, `Read`) is invoked between the test failure and the fix, `sawEditAfterFailure` is never set, and the task is misclassified as `failed_attempt` instead of `bug_fix`.

Example sequence that is misclassified:
```
test_fail → grep (Bash) → edit (Write) → test_pass  ← classified as failed_attempt
```

**Action:** Change `sawEditAfterFailure` to be set when any Edit/Write tool is called after a test failure, regardless of intervening tools. The flag should be persisted across non-edit calls rather than requiring immediacy.

---

### M6. Hardcoded NerdGraph URL in Multiple Source Files

**Severity:** MEDIUM (low security risk, but low flexibility)  
**Files:**
- `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:29`
- `packages/nr-ai-mcp-server/scripts/deploy-alerts.ts:21`
- `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts:34`
- `packages/nr-ai-agent/scripts/deploy-dashboard.ts:17` *(now in `nr-ai-typescript-agent` repo)*
- `packages/nr-ai-cicd/src/nrql-client.ts:1` *(now in `nr-ai-github-tools` repo)*

```typescript
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';
```

This is a public endpoint (not a secret), but duplicating it in five places means an EU region user or anyone using a different NR datacenter has to patch multiple files.

**Action:** Centralize in `packages/shared/src/transport/http-client.ts` alongside the existing region-aware URL helpers, or accept a `nerdgraphUrl` config option derived from the existing `region` config field.

---

## LOW — Minor Issues

### L1. Anti-Pattern Detection: Interrupted Consecutive Call Chain

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts`

A non-Bash tool resets `consecutiveCount`, so a pattern of `Bash(cmd) → Read → Bash(cmd)` is not detected as a repeat. The anti-pattern is real but the detector misses cases where other tools interleave. Low impact since this is a heuristic anyway.

---

### L2. Staging API Endpoints Exposed in Source

**Severity:** LOW (informational)  
**File:** `packages/shared/src/transport/http-client.ts:28,38,48`

The code references `staging-insights-collector.newrelic.com`, `staging-metric-api.newrelic.com`, and `staging-log-api.newrelic.com`. These are public-facing NR staging endpoints (not internal hostnames) used when a staging license key is detected. No action required, but contributors will see that the project was developed against NR's staging environment.

---

### L3. Node.js v24 Mentioned in README Without Enforcement

**Severity:** LOW  
**File:** `README.md`

The README lists `Node.js >= 24` as a system requirement, but the `engines` field is missing from all `package.json` files (see H4). This means the requirement is aspirational but not enforced at install time.

---

## NOT CONFIRMED — Rejected After Code Review

The following were flagged by automated analysis but are **not bugs** on closer inspection:

### LocalStore.drainBuffer() Race Condition (FALSE POSITIVE)

The agent claimed data loss was possible during concurrent writes. The code at `packages/nr-ai-mcp-server/src/storage/local-store.ts:87` uses `renameSync(bufferPath, tmpPath)`, which is atomic on POSIX. Any `appendFileSync` calls that arrive after the rename write to a new `buffer.jsonl`, which is picked up on the next poll cycle. No data is lost. The recovery block (lines 67–80) correctly handles a crash mid-drain. Design is sound.

### HarvestScheduler Signal Handler Leak (FALSE POSITIVE)

The agent claimed `process.once()` listeners would accumulate on multiple `start()` calls. The `start()` method has an early-return guard (`if (this.running) return`) and stores handlers as bound constructor properties (`this.boundBeforeExit`, `this.boundSigterm`). `doStop()` calls `process.removeListener` using the same references. No leak exists.

---

## Open-Source Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| LICENSE file | ❌ Missing | Must add before publish |
| No committed secrets | ✅ Clean | .env not in git history |
| Rotate disk credentials | ⚠️ Needed | test-app/.env (now in nr-ai-typescript-agent repo) has real-looking keys |
| Internal URLs removed | ❌ Needed | source.datanerd.us in ONBOARDING.md |
| CONTRIBUTING.md | ❌ Missing | |
| CODE_OF_CONDUCT.md | ❌ Missing | |
| npm scope available | ⚠️ Unverified | @nr-ai-observatory must be claimed |
| license field in package.json | ❌ Missing | All packages |
| engines field in package.json | ❌ Missing | All packages |
| Wildcard workspace deps | ⚠️ Needs fix | Before npm publish |
| README quality | ✅ Excellent | Comprehensive |
| Security practices | ✅ Strong | Redaction, input validation, audit trail |
| Test coverage | ✅ Good | Co-located tests, clear patterns |
| Dashboard/alert JSON clean | ✅ Clean | No account-specific data |
| No private registry references (code) | ✅ Clean | All deps on public npm |
| No postinstall hooks | ✅ Safe | |
| GitHub Actions | ✅ Portable | No internal CI references |

---

## Recommended Pre-Release Order

1. Add `LICENSE` (30 min)
2. Rotate credentials in `packages/test-app/.env` (now in `nr-ai-typescript-agent` repo), replace with placeholders (15 min)
3. Remove `source.datanerd.us` line from `ONBOARDING.md` (5 min)
4. Add `license`, `engines`, and `repository` fields to all `package.json` files (20 min)
5. Fix workspace dependency wildcards (`"*"` → `"workspace:*"`) (10 min)
6. Create `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (1 hr)
7. Claim or verify `@nr-ai-observatory` npm scope
8. Fix `CostPerOutcome` bug-fix classifier (M5) (1 hr)
9. Fix pricing negative savings validation (M4) (30 min)
10. Address remaining medium/low items at discretion
