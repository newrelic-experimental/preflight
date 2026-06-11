# Release Audit — Pre-Open-Source Review

**Scope:** Flat single-package repo (`src/`); shared code in `src/shared/` (read-only mirror from `nr-ai-typescript-shared`)
**Original audit:** 2026-05-06
**Re-audited:** 2026-06-03 — updated for monorepo breakup, product rename, resolved findings removed
**Reviewed by:** Claude Code (automated multi-agent analysis + manual code verification)

---

## Executive Summary

The codebase is well-structured and security-conscious, with zero committed secrets, comprehensive input validation, and strong documentation. All administrative blockers (LICENSE, CODE_OF_CONDUCT.md, package.json metadata) have been resolved. The only remaining action before publishing is confirming credential rotation in the `nr-ai-typescript-agent` repo.

---

## CRITICAL — Must Fix Before Publishing

---

### C2. Real Credentials on Disk in test-app/.env

**Severity:** CRITICAL
**File:** `packages/test-app/.env` _(now in `nr-ai-typescript-agent` repo)_

The file contained credentials matching the format of real New Relic keys. The file is NOT in git history (`.gitignore` is correctly configured), so this is not a historical leak. However, these keys must be rotated before either repo is made public.

**Status:** Rotation was due at original audit time (2026-05-06). Confirm the three keys (license key, account ID, user API key) have been rotated in the New Relic console and replaced with `your-license-key-here`-style placeholders. This action is in the `nr-ai-typescript-agent` repo.

---

## HIGH — Should Fix Before Publishing

## LOW — Minor Issues

### L2. Staging API Endpoints Exposed in Source

**Severity:** LOW (informational)
**Files:** `src/shared/transport/http-client.ts`, `terraform/main.tf`

The code references `staging-insights-collector.newrelic.com`, `staging-metric-api.newrelic.com`, and `staging-log-api.newrelic.com` (transport layer), and `staging-api.newrelic.com/graphql` (Terraform `var.staging = true`). These are public-facing NR staging endpoints (not internal hostnames) used when a staging license key or `staging = true` is set. No action required, but external contributors will see that the project was developed against NR's staging environment.

---

## Open-Source Readiness Checklist

| Item                                  | Status       | Notes                                                                                                                                                                                                                        |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LICENSE file                          | ✅ Added     | Apache-2.0; `"license"` field added to `package.json`                                                                                                                                                                        |
| No committed secrets                  | ✅ Clean     | `.env` not in git history                                                                                                                                                                                                    |
| Rotate disk credentials               | ⚠️ Confirm   | `test-app/.env` (in `nr-ai-typescript-agent` repo) — confirm keys were rotated                                                                                                                                               |
| Internal URLs removed                 | ⚠️ Note      | `CONTRIBUTING.md` has no internal links. Distribution Channels section contains internal Confluence links intentionally — they are process guidance for NR staff and must be reviewed/removed before the doc ships publicly. |
| CONTRIBUTING.md                       | ✅ Created   |                                                                                                                                                                                                                              |
| CODE_OF_CONDUCT.md                    | ✅ Created   | Contributor Covenant 2.1                                                                                                                                                                                                     |
| npm scope                             | ✅ N/A       | Shared code is synced as source, not a published package; scope claim not required                                                                                                                                           |
| `license` field in package.json       | ✅ Added     | `"Apache-2.0"`                                                                                                                                                                                                               |
| `engines` field in package.json       | ✅ Added     | `>=22.0.0`                                                                                                                                                                                                                   |
| `repository` field in package.json    | ✅ Added     | `github.com/newrelic/nr-ai-coding-observability` — confirm org before publish                                                                                                                                                |
| GitHub org confirmed                  | ⚠️ Confirm   | Verify `newrelic` vs `newrelic-experimental` (or other) before publishing                                                                                                                                                    |
| Workspace wildcard deps               | ✅ Resolved  | Flat repo — no workspaces                                                                                                                                                                                                    |
| README quality                        | ✅ Excellent | Comprehensive                                                                                                                                                                                                                |
| Security practices                    | ✅ Strong    | Redaction, input validation, audit trail                                                                                                                                                                                     |
| Test coverage                         | ✅ Good      | Co-located tests, clear patterns                                                                                                                                                                                             |
| Dashboard/alert JSON clean            | ✅ Clean     | No account-specific data                                                                                                                                                                                                     |
| Terraform state files gitignored      | ✅ Clean     | `.terraform/`, `*.tfstate`, `*.tfstate.backup`, `*.tfvars` all in `.gitignore`                                                                                                                                               |
| No private registry references (code) | ✅ Clean     | All deps on public npm                                                                                                                                                                                                       |
| No postinstall hooks                  | ✅ Safe      |                                                                                                                                                                                                                              |
| GitHub Actions                        | ✅ Portable  | No internal CI references                                                                                                                                                                                                    |

---

## Distribution Channels

This section documents all planned distribution channels, the internal process or tooling required for each, and any blockers specific to that channel.

### 1. GitHub — `newrelic-experimental`

**Category:** Experimental
**Status:** ⚠️ Pending OSPO repo creation

The Experimental category is the correct fit: code is being developed in the open for feedback on a new feature, without a committed long-term maintainer. Legal and Security requirements still apply even without a maintainer; the Community-level maintainer requirement is waived.

**Process:**

- Request repo creation via OSPO (Confluence: [New Relic Open Source Project Categories](https://newrelic.atlassian.net/wiki/spaces/OSPO/pages/3514794945), [How to Request Access to NR GitHub Cloud](https://newrelic.atlassian.net/wiki/spaces/OSPO/pages/3011281084))
- `@newrelic.com` GitHub identity must be linked via Okta SSO before the request
- README must include the standard NR Experimental category header/badge
- Resolve `repository` URL in `package.json` to match the final `newrelic-experimental` repo URL before npm publish (npm trusted publishing requires an exact match — see npm section below)

---

### 2. npm — `newrelic` namespace on npmjs.com

**Status:** ⚠️ Requires Node.js agent team contact

As of June 2026, all publishing to the `newrelic` account on npmjs.com is gated through the Node.js agent team. A migration to a proper npmjs.com org with per-team ownership is actively in progress (Confluence: [2026-06 Convert to npmjs.com Organization](https://newrelic.atlassian.net/wiki/spaces/NA/pages/5657461073)). Reaching out now means the package may land under the new org structure directly.

**Required publish method:** GitHub Actions OIDC trusted publishing — no long-lived tokens (Confluence: [2025 NPM Trusted Publishing](https://newrelic.atlassian.net/wiki/spaces/NA/pages/4703551842)).

**Process:**

- Contact the Node.js agent team to register `nr-ai-observe` under the `newrelic` account (or org, once converted)
- Add a publish GitHub Actions workflow to `.github/workflows/publish.yml` using the template in the NPM Trusted Publishing doc:
  - Node.js 24.x, npm 11.5.1+
  - `permissions: { contents: write, id-token: write }`
  - `registry-url: https://registry.npmjs.org`
  - `npm publish` (no `--access public` needed for unscoped packages)
- On the npmjs.com package settings page, set the GitHub Actions trusted publisher (org, repo, workflow filename) and require 2FA for local publish
- `repository.url` in `package.json` must exactly match the publishing repo URL

**Install command for users:**

```
npx nr-ai-observe setup
```

---

### 3. Homebrew

**Status:** ⚠️ Greenfield — no existing public tap

The internal `newrelic/commune` tap on `source.datanerd.us` is for internal tools distributed via Artifactory and is not accessible to external users. There is no documented public Homebrew tap process internally.

**Process:**

- Create a new public repo `newrelic-experimental/homebrew-tap` on GitHub.com
- Add a Ruby formula file `Formula/nr-ai-observe.rb` that downloads the binary from GitHub Releases (not Artifactory)
- Add a CI workflow (or extend the npm publish workflow) that auto-updates the formula's `url` and `sha256` after each release, via a PR to `homebrew-tap`
- Users install via:
  ```
  brew tap newrelic-experimental/homebrew-tap
  brew install nr-ai-observe
  ```

A macOS binary (arm64 + x86_64 universal or separate bottles) must be included in each GitHub Release for the formula to download.

---

### 4. MCP Registries

**Status:** ⚠️ Pending submission (do after GitHub repo is public)

The primary audience — Claude Code, Cursor, Windsurf, and other MCP-speaking clients — discovers MCP servers through these registries before reaching GitHub or npm. Both accept submissions after the GitHub repo is public.

| Registry | URL                          | Submission method                              |
| -------- | ---------------------------- | ---------------------------------------------- |
| Smithery | https://smithery.ai          | `npx @smithery/cli publish` from the repo root |
| glama.ai | https://glama.ai/mcp/servers | Web form / directory submission                |

The `smithery.yaml` configuration file (if required) should declare the server's tools, transport type (`stdio`), and install command.

---

### 5. New Relic Instant Observability (I/O) Catalog

**Status:** ⚠️ Pending submission

The I/O catalog is NR's internal and customer-facing integration directory. Listing here drives discovery from existing NR users — the most natural early adopter segment.

**Process:**

- Submit via the I/O Ecosystem process (Confluence: [I/O Ecosystem Runbook](https://newrelic.atlassian.net/wiki/spaces/DE/pages/3136882162))
- Category: AI / Developer Tooling
- Requires: public GitHub repo, README with install instructions, working quickstart config

---

## Recommended Pre-Release Order

1. Confirm credential rotation in `nr-ai-typescript-agent` repo's `test-app/.env` (15 min)
2. Contact OSPO to create `newrelic-experimental/nr-ai-coding-observability` repo; link GitHub identity via Okta if not already done (30 min)
3. Confirm final GitHub org and update `repository.url` in `package.json` AND the clone URL in `README.md` to the public repo URL — required for npm trusted publishing (5 min)
   3a. Add NR Experimental category header/badge to `README.md` — required for the Experimental category (10 min)
   3b. Review `docs/RELEASE_AUDIT.md` for internal-only content (Confluence links, `source.datanerd.us` references) and remove or replace before the repo goes public (15 min)
4. Contact Node.js agent team to register `nr-ai-observe` on npmjs.com and set up trusted publishing (async — allow 1–3 business days)
5. Add `.github/workflows/publish.yml` trusted publishing workflow (30 min)
6. Create `newrelic-experimental/homebrew-tap` repo and initial formula (1–2 hours)
7. Cut first public release: push tag → GitHub Release with macOS binary → npm publish → Homebrew formula update
8. Submit to Smithery and glama.ai MCP registries (30 min)
9. Submit I/O catalog listing (async)
