# Public Release Plan

This repo (`source.datanerd.us/cdehaan/preflight`) is developed internally and mirrored to the public GitHub repo (`github.com/newrelic-experimental/preflight`). The one-time initial migration already happened — **the section below, "Releasing a New Version," is the process for every release going forward.** A rare full re-derivation path and a short historical record of the original migration are further down, for reference only.

Do not push this file to the public repo — it's in `scripts/verify-public-diff.sh`'s excluded-paths list.

---

## Releasing a New Version

Every release is a lightweight incremental sync: a GHE squash commit lands on private `main`, and that single commit gets cherry-picked into the already-migrated public clone, then a version is cut on the public side.

### 1. Sync the code change

```bash
# Go to the public clone and pull it up to date first
cd ~/Documents/development/personal/preflight-public
git pull --ff-only origin main

# Create a branch and apply the change surgically —
# NEVER `cp` whole files from the private repo. Read the GHE diff and
# apply only the changed lines by hand, stripping any internal-only
# content as you go.
git checkout -b chore/vX.X.X-sync

# Run the leak check before pushing — this must pass
../nr-ai-observatory/scripts/verify-public-diff.sh

# Push and open the PR
git push origin chore/vX.X.X-sync
GH_HOST=github.com gh pr create --base main --head chore/vX.X.X-sync ...
```

`scripts/verify-public-diff.sh` (private repo) is a regression guard, not a
full leak audit — see its header comment and
`scripts/public-leak-patterns.txt`'s caveats. A couple of past leaks were
one-off prose too brittle to encode as a pattern; `SECURITY.md` and
`PRIVACY.md` still deserve a manual skim on release syncs.

**This is a different workflow from the one-time migration described further
below — it does not use `migrate-to-public.sh` or `remove-staging.ts`.**
Those two scripts mutate/validate a from-scratch cleanup branch; an
incremental sync starts from a clean public `main` that's already free of
internal content, so none of their checks apply here.

### 2. Cut the release

Once the sync PR merges to the public repo's `main`:

```bash
# On the public repo (newrelic-experimental/preflight)
cd ~/Documents/development/personal/preflight-public
git pull origin main
npm version patch   # or minor / major
git push origin main --follow-tags
```

The `v*.*.*` tag triggers `.github/workflows/release.yml` automatically: it
runs `npm ci`, `npm run build`, `npm test`, publishes to npm via OIDC trusted
publishing (no manual `npm publish` step — this has been configured and
working since shortly after the initial migration), and creates a GitHub
release with auto-generated notes.

---

## Files Excluded from Public Repo

| File | Reason |
|------|--------|
| `docs/IMPLEMENTATION.md` | Internal architecture planning |
| `docs/PRODUCT_BRIEF.md` | Internal product strategy doc |
| `docs/ROADMAP.md` | Internal roadmap (cross-references PRODUCT_BRIEF) |
| `docs/PUBLIC_RELEASE_PLAN.md` | This file |
| `scripts/migrate-to-public.sh` | Full re-derivation script with internal paths |
| `scripts/sync-shared.ts` | Syncs from the private shared-code repo; unusable by external contributors |
| `scripts/remove-staging.ts` | Strips staging-environment support; internal tooling for cleanup-branch preparation |
| `scripts/verify-public-diff.sh` | Regression guard for the sync workflow above; references internal paths |
| `scripts/public-leak-patterns.txt` | Data file for `verify-public-diff.sh`; may reference internal identifiers |

Files that look internal but **stay in the public repo:**
- `CONTRIBUTING.md` — needed for contributors
- `docs/ADVANCED.md` — useful for power users
- `SECURITY.md` — important for contributors
- `PRIVACY.md` — important for contributors
- `docs/TEST_PATTERNS.md` — needed for contributors
- `docs/COMMANDS_TABLE.md` — reference for users
- `docs/METRICS_TABLE.md` — reference for users

---

## Full Re-Derivation (rare)

**This is not the normal release path — see "Releasing a New Version" above
for that.** Use this only when the public and private branches have drifted
enough that patching incrementally is riskier than rebuilding the public
branch from a clean private `main` (e.g. several accumulated fixes need to
land on both repos at once — this happened once, for v1.0.5).

1. Create a cleanup branch from private `main`: `chore/prepare-for-public-release`.
2. Remove the internal-only files listed in "Files Excluded from Public Repo"
   above (`git rm` the docs, `git rm --cached scripts/migrate-to-public.sh`
   so it stays on disk and runnable), and run
   `npx tsx scripts/remove-staging.ts` to strip staging-environment support
   (still present in private `main` — see `src/shared/transport/http-client.ts`).
   Removing `scripts/sync-shared.ts` also means dropping the `sync:shared`
   entry from `package.json`.
3. Run `npm run build && npm test` — both must pass with 0 errors/failures
   before proceeding.
4. Run `scripts/migrate-to-public.sh --check` and fix everything it flags
   (internal repo references, staging references, `package.json` fields,
   excluded files still tracked, secrets in git history). Don't hand-chase
   specific line numbers from an old checklist — the script's checks are the
   source of truth and won't drift the way a fixed list does. Note: the
   NR Experimental badge check here is a non-blocking warning only — as of
   this writing the badge has never actually been added to either repo's
   README, so add it manually if desired (OSPO-recommended, not required):
   ```markdown
   [![New Relic Experimental](https://github.com/newrelic/opensource-website/raw/main/src/images/categories/Experimental.png)](https://opensource.newrelic.com/oss-category/#new-relic-experimental)
   ```
5. Run `scripts/migrate-to-public.sh` (without `--check`) to push the
   cleanup branch to the public remote as `main`, and to write
   `.github/workflows/release.yml` and `.github/CODEOWNERS` into the public
   clone.
6. Verify:
   ```bash
   cd ~/Documents/development/personal/preflight-public
   git pull origin main
   ls docs/                          # excluded files must be absent
   grep -r "staging-one\|staging-api" . --include="*.md" --include="*.ts"  # empty
   ```

---

## Historical: Initial Migration Record

For context only — no action needed. The initial migration (137 commits, full
history) ran via a `chore/prepare-for-public-release` branch pushed directly
to the public remote as `main`, establishing `github.com/newrelic-experimental/preflight`.
It stripped internal docs, staging-environment support, and internal repo
references, and set up `CODEOWNERS` and the release workflow. npm trusted
publishing (OIDC) was configured shortly after and has handled every release
since — publishing to npm is no longer a manual step.
