# Public Release Migration Plan

Migration from internal GHE (`source.datanerd.us/cdehaan/nr-ai-coding-observability`) to the public GitHub repo (`github.com/newrelic-experimental/preflight`). Do not push this file to the public repo.

## Overview

- **Source repo:** `/Users/cdehaan/Documents/development/personal/nr-ai-observatory`
- **Destination local clone:** `/Users/cdehaan/Documents/development/newrelic-experimental/preflight`
- **Destination remote:** `https://github.com/newrelic-experimental/preflight`
- **Commits to migrate:** 137 (full history)
- **Migration method:** push cleanup branch from private repo as `main` to public remote

---

## How This Works (Important)

The cleanup branch is created in the **private repo only** and pushed directly to the public GitHub remote as `main`. The private repo's `main` is never touched and keeps all internal files intact.

```
private main  ──────────────────────────────────────► untouched (keeps everything)
              \
               chore/prepare-for-public-release
               (internal files removed, staging cleaned)
                    \
                     git push public chore/prepare-for-public-release:main
                                \
                                 public GitHub main (full history + cleanup commit at tip)
```

The 137-commit history goes to the public repo in full. Internal docs will technically appear in old commits, but since they contain no secrets that's fine. The current state of the public repo (the tip) is clean.

---

## Pre-Flight Checklist

Work through each item on a feature branch (`chore/prepare-for-public-release`) in the **private repo**. Run `scripts/migrate-to-public.sh --check` from that branch to validate before pushing.

### 1. History Audit

Scan the full git history for accidentally committed secrets before it goes public.

```bash
# Check for license keys (NRAK-, NRAA-, NRII-)
git log -p --all | grep -E 'NR[AIRLK]{2}-[A-Z0-9]{40}'

# Check for common secret patterns
git log -p --all | grep -iE \
  '(api[_-]?key|license[_-]?key|secret|password|token)\s*[:=]\s*['\''"][^'\''"\s]{8,}'

# Broader sweep with trufflehog if available
which trufflehog && trufflehog git file://$(pwd) --only-verified
```

Expected: no matches. If anything surfaces, use `git filter-repo` to scrub before proceeding.

### 2. Remove Internal-Only Docs and Scripts

These files exist only for internal use and must not go public. Delete them in the pre-flight commit.

```bash
git rm docs/IMPLEMENTATION.md
git rm docs/PRODUCT_BRIEF.md
git rm docs/RELEASE_AUDIT.md
git rm docs/ROADMAP.md
git rm docs/PUBLIC_RELEASE_PLAN.md
git rm scripts/sync-shared.ts
git rm scripts/remove-staging.ts

# Use --cached for the migration script so it stays on disk and can still be executed.
# git ls-files (not -f) is what the pre-flight check validates, so --cached is correct.
git rm --cached scripts/migrate-to-public.sh
```

Note: run `scripts/remove-staging.ts` (step 5) **before** `git rm`'ing the scripts above — once they're removed from disk via `git rm`, you can't run them.

### 2b. Update package.json, CLAUDE.md, CONTRIBUTING.md, and SECURITY.md after removing sync-shared.ts

Removing `scripts/sync-shared.ts` requires two follow-on edits:

**`package.json` — remove the `sync:shared` script entry:**
```json
// Delete this line:
"sync:shared": "npx tsx scripts/sync-shared.ts",
```

**`CLAUDE.md` — remove or update sync references.** Several lines reference `npm run sync:shared` and `nr-ai-typescript-shared`. Replace the sync-specific guidance with a note that `src/shared/` is a vendored snapshot and external contributors should treat it as read-only. Specifically:

- Line 3: remove "(synced from `nr-ai-typescript-shared` via `npm run sync:shared`)", remove "The TypeScript SDK agent lives in the separate `nr-ai-typescript-agent` repo.", remove "CI/CD tooling and GitHub App webhook server live in the separate `nr-ai-github-tools` repo."
- Line 22: remove the "To pull in upstream changes…" paragraph entirely
- Line 33: update the `src/shared/` rule — keep "never edit here" but drop the sync instruction
- Lines 37–38: simplify rule 1 to remove the upstream repo workflow; remove rules 2 and 3 (they only make sense with access to the upstream repos)
- Line 48: update the tree comment from "synced from nr-ai-typescript-shared via scripts/sync-shared.ts" to "vendored snapshot — do not edit directly"
- Line 134: remove `sync-shared.ts` from the scripts directory listing
- Line 172: remove "(pure TypeScript, synced from `nr-ai-typescript-shared`)"
- Lines 359, 373: remove the `nr-ai-typescript-agent` repo parentheticals from the Phase 4 SDK Agent Events section

**`CONTRIBUTING.md` — internal repo references (separate from the staging cleanup in step 5):**
- Line 15: "SDK Agent — Lives in the separate `nr-ai-typescript-agent` repo…" — `nr-ai-typescript-agent` is a private internal repo. Replace with "companion SDK agent (not included in this repo)"
- Line 17: "synced from `nr-ai-typescript-shared`" — replace with "vendored in `src/shared/`"
- Line 55: entire `npm run sync:shared` row in the commands table — remove it
- Line 84: "Make the change in the upstream `nr-ai-typescript-shared` repo, then run `npm run sync:shared`…" — replace with "Do not edit `src/shared/` directly; it is a vendored snapshot"
- Line 95: "synced from nr-ai-typescript-shared" comment — update to "vendored snapshot"
- Line 111: scripts directory listing includes `sync-shared.ts` — remove it
- Line 118: "The foundation layer is synced from `nr-ai-typescript-shared`" — update to "The foundation layer is vendored in `src/shared/`"

**`docs/SECURITY.md` — references to the private `nr-ai-typescript-agent` repo:**
- Line 68: "all six wrappers in the `nr-ai-typescript-agent` repo (`src/wrappers/`)" — replace with "the companion SDK agent"
- Line 105: "`nr-ai-agent` wrapper (in the separate `nr-ai-typescript-agent` repo)" — replace with "the companion SDK agent"
- Line 259: "Stream listener cleanup — `src/wrappers/anthropic.ts` in the `nr-ai-typescript-agent` repo" — replace with "the companion SDK agent"

### 3. Update CODEOWNERS

`.github/CODEOWNERS` currently contains `* @cdehaan`. Replace with the org team or remove the file entirely.

```
# Replace with:
* @newrelic-experimental/preflight-maintainers
```

Or `git rm .github/CODEOWNERS` if no team is set up yet — GitHub defaults to no required reviewers without the file.

### 4. Add NR Experimental Badge to README

Required by OSPO before the repo goes public. Add immediately below the main heading in `README.md`:

```markdown
[![New Relic Experimental](https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png)](https://opensource.newrelic.com/oss-category/#new-relic-experimental)
```

### 5. Remove Staging Support (run the script)

Run `scripts/remove-staging.ts` on the cleanup branch to strip all staging support from source, tests, and `src/shared/`:

```bash
npx tsx scripts/remove-staging.ts
npm run build   # must pass with 0 errors
npm test        # must pass with 0 failures
```

The script modifies 12 files: `src/shared/transport/http-client.ts`, `src/index.ts`, `src/tools/cross-session-tools.ts`, `src/install/setup-wizard.ts`, `src/install/key-validator.ts`, `src/deploy/deploy-dashboards.ts`, `src/deploy/deploy-alerts.ts`, `scripts/backfill-sessions.ts`, and the corresponding test files. It fails loudly if any expected pattern is not found — do not proceed to build/test until the script exits cleanly.

### 5b. Remove Internal Staging References from Docs

**`README.md` — line ~104:**
Remove the `staging-one.newrelic.com` mention. Replace:
> "Add `--staging` if your account is on `staging-one.newrelic.com`…"

With:
> "Add `--staging` for the New Relic staging environment, `--eu` for EU region accounts…"

**`CONTRIBUTING.md` — "Staging environment (internal)" callout (~line 383):**
Delete the entire blockquote:
```
> **Staging environment (internal):** The cloud path below targets `staging-one.newrelic.com`...
```

**`CONTRIBUTING.md` — "Deploy dashboards and alerts (cloud path)" section (~lines 463–494):**
This section uses `--staging` throughout. Replace with production deploy commands (no `--staging`):

```bash
# Dashboards
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  preflight deploy-dashboards --all

# Alerts (optional)
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  preflight deploy-alerts
```

Also update the corresponding Teardown section to use production commands.

**`CONTRIBUTING.md` — troubleshooting table row (~line 510):**
Remove the row: `| HTTP 401 on deploy | Using a production key against staging | Use a key from staging-one.newrelic.com... |`

**`docs/ADVANCED.md` — line 231:**
Remove "and intentional for NR-internal use" from:
> "The `staging = true` flag routes NerdGraph calls to `staging-api.newrelic.com/graphql`. The provider emits a deprecation warning for `nerdgraph_api_url` — this is expected and intentional for NR-internal use."

### 6. Inspect and Decide on Stashed Launch Content

Three files are in `git stash@{0}` on main:
- `WHATS_NEW.md` — launch announcement copy (needs `getStartedLink` filled in)
- `BLOG_POST.md` — draft blog post
- `BIO.md` — author bio

These are launch marketing assets, not repo documentation. Recommended: do not pop them into the public repo. Keep the stash locally on the private repo for use when submitting the What's New post.

### 7. Verify the GitHub Actions release workflow

`.github/workflows/release.yml` is **not** pre-committed to the private repo — the migration script creates it directly in the public clone after the push. This keeps the private GHE repo free of GitHub Actions configs that serve no purpose there.

The workflow triggers on `v*.*.*` tags and:
- Runs `npm ci`, `npm run build`, `npm test`
- Publishes to npm via OIDC provenance (`--access public --provenance`)
- Creates a GitHub release with auto-generated notes

`scripts/migrate-to-public.sh` writes and commits the file to the public clone automatically. If the public clone isn't present at the expected path, the script prints instructions to set it up first.

**Before the first publish works**, the package must be registered for OIDC trusted publishing on npmjs.com. Contact James Sumners (Node.js agent team) to register `@newrelic/preflight`. Until that's done, the workflow will fail at the publish step — that's expected for v0.1.0 which is published manually.

**To cut a release after the public repo is live:**
```bash
# On the public repo (newrelic-experimental/preflight)
npm version patch   # or minor / major
git push origin main --follow-tags
# The v* tag triggers the release workflow automatically
```

### 8. Verify package.json

Confirm these fields are correct for the public package:

```json
{
  "name": "@newrelic/preflight",
  "homepage": "https://github.com/newrelic-experimental/preflight",
  "repository": {
    "type": "git",
    "url": "https://github.com/newrelic-experimental/preflight.git"
  },
  "bugs": {
    "url": "https://github.com/newrelic-experimental/preflight/issues"
  }
}
```

---

## Migration Steps

After all pre-flight items are checked off, while still on `chore/prepare-for-public-release`:

```bash
# 1. Add the public remote to the source repo (if not already added)
cd /Users/cdehaan/Documents/development/personal/nr-ai-observatory
git remote add public https://github.com/newrelic-experimental/preflight

# 2. Push the cleanup branch to the public remote AS main
#    (the public repo is empty — no --force needed)
git push public chore/prepare-for-public-release:main

# 3. Push tags if any exist
git push public --tags

# 4. Private main is untouched — do NOT merge the cleanup branch back
```

Or run `scripts/migrate-to-public.sh` from the cleanup branch, which does the above with pre-flight validation.

---

## Post-Migration Verification

```bash
# 1. In the destination clone, pull and confirm
cd /Users/cdehaan/Documents/development/newrelic-experimental/preflight
git pull origin main
git log --oneline | head -5       # should show the pre-flight commit at top
ls docs/                           # PRODUCT_BRIEF, ROADMAP, RELEASE_AUDIT, IMPLEMENTATION should be absent

# 2. Confirm the NR Experimental badge renders
open https://github.com/newrelic-experimental/preflight

# 3. Confirm excluded files are absent
! test -f docs/PRODUCT_BRIEF.md && echo "OK"
! test -f docs/ROADMAP.md && echo "OK"
! test -f docs/RELEASE_AUDIT.md && echo "OK"
! test -f docs/IMPLEMENTATION.md && echo "OK"
! test -f scripts/migrate-to-public.sh && echo "OK"
! test -f scripts/sync-shared.ts && echo "OK"

# 4. Confirm no staging-one.newrelic.com references remain
grep -r "staging-one" . --include="*.md" --include="*.ts"  # should be empty
```

---

## Files Excluded from Public Repo

| File | Reason |
|------|--------|
| `docs/IMPLEMENTATION.md` | Internal architecture planning |
| `docs/PRODUCT_BRIEF.md` | Internal product strategy doc |
| `docs/RELEASE_AUDIT.md` | Internal release checklist with Confluence links |
| `docs/ROADMAP.md` | Internal roadmap (cross-references PRODUCT_BRIEF) |
| `docs/PUBLIC_RELEASE_PLAN.md` | This file — internal migration checklist |
| `scripts/migrate-to-public.sh` | One-time migration script with internal paths |
| `scripts/sync-shared.ts` | Syncs from private `nr-ai-typescript-shared` repo; unusable by external contributors |
| `scripts/remove-staging.ts` | One-time staging removal script; internal tooling for cleanup branch preparation |

Files that look internal but **stay in the public repo:**
- `CONTRIBUTING.md` — needed for contributors (after staging section cleanup)
- `docs/ADVANCED.md` — useful for power users (after NR-internal note cleanup)
- `docs/SECURITY.md` — important for contributors
- `docs/TEST_PATTERNS.md` — needed for contributors
- `docs/COMMANDS_TABLE.md` — reference for users
- `docs/METRICS_TABLE.md` — reference for users
