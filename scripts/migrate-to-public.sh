#!/usr/bin/env bash
# migrate-to-public.sh — Validate pre-flight and push main to the public GitHub repo.
#
# Usage:
#   scripts/migrate-to-public.sh          # run all checks then push
#   scripts/migrate-to-public.sh --check  # run checks only, no push
#
# All checks must pass before the push proceeds.

set -euo pipefail

PUBLIC_REMOTE_URL="https://github.com/newrelic-experimental/preflight"
REMOTE_NAME="public"
PASS="✓"
FAIL="✗"
WARN="!"
errors=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

check_pass() { printf "  %s  %s\n" "$PASS" "$1"; }
check_fail() { printf "  %s  %s\n" "$FAIL" "$1"; (( errors++ )) || true; }
check_warn() { printf "  %s  %s\n" "$WARN" "$1"; }

require_clean_branch() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$branch" == "main" ]]; then
    check_fail "Currently on main — run this from the cleanup branch (chore/prepare-for-public-release) to avoid pushing internal files from private main"
    return
  fi
  check_pass "On branch '$branch' (not private main)"

  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    check_fail "Working tree is dirty — commit all changes before migrating"
  else
    check_pass "Working tree is clean"
  fi
}

check_excluded_files() {
  # Check the git INDEX (not the filesystem) — what will actually be pushed.
  # This lets scripts/migrate-to-public.sh stay on disk via `git rm --cached`
  # so it can still be executed after the pre-flight commit.
  local tracked=0
  for f in \
    "docs/IMPLEMENTATION.md" \
    "docs/PRODUCT_BRIEF.md" \
    "docs/RELEASE_AUDIT.md" \
    "docs/ROADMAP.md" \
    "docs/PUBLIC_RELEASE_PLAN.md" \
    "scripts/migrate-to-public.sh" \
    "scripts/sync-shared.ts" \
    "scripts/remove-staging.ts"
  do
    if git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
      check_fail "Internal file still tracked in git index: $f (run: git rm $f)"
      tracked=1
    fi
  done
  if [[ "$tracked" -eq 0 ]]; then
    check_pass "Internal files removed from git index"
  fi
}

check_nr_experimental_badge() {
  if grep -q "opensource-website.*Experimental" README.md 2>/dev/null; then
    check_pass "NR Experimental badge present in README"
  else
    check_warn "NR Experimental badge not in README (recommended for newrelic-experimental repos, not blocking)"
  fi
}

check_staging_internal_refs() {
  local matches
  matches=$(grep -rEn "staging-one\.newrelic\.com|NR-internal use|internal staging" \
    --include="*.md" --include="*.ts" . 2>/dev/null \
    | grep -v ".git/" || true)
  if [[ -n "$matches" ]]; then
    check_fail "Internal staging references still present:"
    echo "$matches" | sed 's/^/      /'
  else
    check_pass "No internal staging references found"
  fi
}

check_internal_repo_refs() {
  local matches
  matches=$(grep -rEn \
    "nr-ai-typescript-shared|nr-ai-typescript-agent|nr-ai-github-tools|sync:shared|sync-shared" \
    --include="*.md" --include="*.json" --include="*.ts" . 2>/dev/null \
    | grep -vE ".git/|package-lock" || true)
  if [[ -n "$matches" ]]; then
    check_fail "Internal repo references still present:"
    echo "$matches" | sed 's/^/      /'
  else
    check_pass "No internal repo references found"
  fi
}

check_history_for_secrets() {
  printf "  Scanning git history for secret patterns (this may take a moment)...\n"
  local found=0

  # NR key prefixes
  if git log -p --all -- . 2>/dev/null \
      | grep -qE 'NR[AIRLK]{2}-[A-Z0-9]{36,}'; then
    check_fail "Possible NR API/license key found in git history — run 'git log -p --all | grep -E NR' to inspect"
    found=1
  fi

  if [[ "$found" -eq 0 ]]; then
    check_pass "No obvious secrets found in git history"
  fi
  check_warn "Consider running trufflehog for a deeper scan: trufflehog git file://\$(pwd)"
}

check_package_json() {
  local repo_url
  repo_url=$(node -e "const p=require('./package.json'); console.log((p.repository||{}).url||'')" 2>/dev/null || true)
  if echo "$repo_url" | grep -q "newrelic-experimental/preflight"; then
    check_pass "package.json repository URL points to newrelic-experimental/preflight"
  else
    check_warn "package.json repository URL may need updating to newrelic-experimental/preflight (current: '$repo_url')"
  fi

  if node -e "const p=require('./package.json'); process.exit(p.scripts&&p.scripts['sync:shared']?1:0)" 2>/dev/null; then
    check_pass "package.json 'sync:shared' script removed"
  else
    check_fail "package.json still contains 'sync:shared' — remove it along with scripts/sync-shared.ts"
  fi
}

check_remote() {
  if git remote | grep -q "^${REMOTE_NAME}$"; then
    local url
    url=$(git remote get-url "$REMOTE_NAME")
    if [[ "$url" == "$PUBLIC_REMOTE_URL" ]]; then
      check_pass "Remote '$REMOTE_NAME' already set to $PUBLIC_REMOTE_URL"
    else
      check_fail "Remote '$REMOTE_NAME' exists but points to '$url', expected '$PUBLIC_REMOTE_URL'"
    fi
  else
    check_warn "Remote '$REMOTE_NAME' not configured — will add it before pushing"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

cd "$(git rev-parse --show-toplevel)"

echo ""
echo "Preflight → Public GitHub Migration"
echo "===================================="
echo ""
echo "Checks:"
echo ""

require_clean_branch
check_excluded_files
check_nr_experimental_badge
check_staging_internal_refs
check_internal_repo_refs
check_package_json
check_history_for_secrets
check_remote

echo ""

if [[ "$errors" -gt 0 ]]; then
  echo "  $errors check(s) failed. Fix the issues above and re-run."
  echo ""
  exit 1
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo "  All checks passed. Run without --check to proceed with the push."
  echo ""
  exit 0
fi

echo "  All checks passed."
echo ""
echo "Pushing to $PUBLIC_REMOTE_URL ..."
echo ""

# Add the remote if it doesn't exist yet
if ! git remote | grep -q "^${REMOTE_NAME}$"; then
  git remote add "$REMOTE_NAME" "$PUBLIC_REMOTE_URL"
  echo "  Added remote '$REMOTE_NAME' → $PUBLIC_REMOTE_URL"
fi

branch=$(git rev-parse --abbrev-ref HEAD)
git push "$REMOTE_NAME" "${branch}:main"

# Push version tags only (v*) — avoids leaking internal dev/scratch tags
if git tag -l 'v*' | grep -q .; then
  git push "$REMOTE_NAME" 'refs/tags/v*'
  echo "  Version tags pushed."
fi

echo ""
echo "Creating GitHub Actions release workflow in public repo..."
echo ""

PUBLIC_CLONE_DIR="/Users/cdehaan/Documents/development/newrelic-experimental/preflight"
PRIVATE_REPO_DIR="$(pwd)"

if [[ -d "$PUBLIC_CLONE_DIR/.git" ]]; then
  cd "$PUBLIC_CLONE_DIR"
  git checkout main
  git pull --ff-only origin main
  mkdir -p .github/workflows
  cat > .github/workflows/release.yml << 'WORKFLOW_EOF'
name: Release
on:
  push:
    tags: ['v*.*.*']
permissions:
  contents: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
WORKFLOW_EOF
  # Rewrite CODEOWNERS to public GitHub username
  printf '* @chrisdhaan\n' > .github/CODEOWNERS

  git add .github/workflows/release.yml .github/CODEOWNERS
  if git diff --cached --quiet; then
    echo "  Post-migration files already up to date — skipping commit."
  else
    git commit -m "Chore: add release workflow and update CODEOWNERS for public repo"
    git push origin main
    echo "  Release workflow and CODEOWNERS committed and pushed."
  fi
  cd "$PRIVATE_REPO_DIR"
else
  echo "  ! Public clone not found at $PUBLIC_CLONE_DIR"
  echo "    Clone first: git clone https://github.com/newrelic-experimental/preflight $PUBLIC_CLONE_DIR"
  echo "    Then re-run this script, or add .github/workflows/release.yml manually."
fi

echo ""
echo "Done. Verify at: https://github.com/newrelic-experimental/preflight"
echo ""
echo "Post-migration steps:"
echo ""
echo "  Verify:"
echo "    cd /Users/cdehaan/Documents/development/newrelic-experimental/preflight && git pull"
echo "    ls docs/   # excluded files must be absent"
echo "    open https://github.com/newrelic-experimental/preflight"
echo ""
echo "  First release (v0.1.0 — manual, OIDC not yet wired):"
echo "    cd $PUBLIC_CLONE_DIR   # must run from the public clone"
echo "    npm version patch   # bumps package.json + creates git tag"
echo "    git push origin main --follow-tags"
echo "    npm publish --access public   # manual until OIDC trusted publishing is set up"
echo "    gh release create v\$(node -p 'require(\"./package.json\").version') --generate-notes"
echo ""
echo "  OIDC trusted publishing setup (one-time):"
echo "    Contact James Sumners (Node.js agent team) to register @newrelic/preflight"
echo "    on npmjs.com. Once done, .github/workflows/release.yml handles all future"
echo "    releases automatically on version tag push."
echo ""
echo "  Distribution:"
echo "    Smithery:     npx @smithery/cli publish (from repo root)"
echo "    NR I/O:       Submit via I/O Ecosystem Runbook on Confluence"
echo ""
