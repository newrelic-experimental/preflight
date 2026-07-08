#!/usr/bin/env bash
# verify-public-diff.sh — Scan an incremental public-repo sync's outgoing
# diff for known internal-only content before it's pushed.
#
# This is a regression guard for the routine cherry-pick sync workflow
# documented in docs/PUBLIC_RELEASE_PLAN.md ("Incremental Version Syncs"),
# not a full leak audit — see scripts/public-leak-patterns.txt for its
# caveats. SECURITY.md and PRIVACY.md still deserve a manual skim on
# release syncs.
#
# Usage:
#   scripts/verify-public-diff.sh [public-clone-path]
#
# Exits 0 if the outgoing diff is clean, 1 if any check fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$SCRIPT_DIR/public-leak-patterns.txt"
DEFAULT_PUBLIC_CLONE_DIR="/Users/cdehaan/Documents/development/personal/preflight-public"
PUBLIC_CLONE_DIR="${1:-$DEFAULT_PUBLIC_CLONE_DIR}"

PASS="✓"
FAIL="✗"
errors=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

check_pass() { printf "  %s  %s\n" "$PASS" "$1"; }
check_fail() { printf "  %s  %s\n" "$FAIL" "$1"; (( errors++ )) || true; }

require_public_clone() {
  if [[ ! -d "$PUBLIC_CLONE_DIR/.git" ]]; then
    echo "Public clone not found at $PUBLIC_CLONE_DIR" >&2
    exit 1
  fi
}

require_not_main() {
  local branch
  branch=$(git -C "$PUBLIC_CLONE_DIR" rev-parse --abbrev-ref HEAD)
  if [[ "$branch" == "main" ]]; then
    echo "Currently on main in $PUBLIC_CLONE_DIR — checkout the sync branch first" >&2
    exit 1
  fi
}

fetch_origin() {
  local fetch_err
  if ! fetch_err=$(git -C "$PUBLIC_CLONE_DIR" fetch origin main 2>&1 >/dev/null); then
    echo "git fetch origin main failed in $PUBLIC_CLONE_DIR" >&2
    echo "$fetch_err" >&2
    exit 1
  fi
}

compute_diff() {
  git -C "$PUBLIC_CLONE_DIR" diff origin/main...HEAD
}

EXCLUDED_PATHS=(
  "docs/INTERNAL_USAGE.md"
  "docs/IMPLEMENTATION.md"
  "docs/PRODUCT_BRIEF.md"
  "docs/ROADMAP.md"
  "docs/PUBLIC_RELEASE_PLAN.md"
  "scripts/migrate-to-public.sh"
  "scripts/remove-staging.ts"
  "scripts/sync-shared.ts"
  "scripts/verify-public-diff.sh"
  "scripts/public-leak-patterns.txt"
)

check_excluded_paths() {
  local diff="$1"
  local touched
  touched=$(printf '%s\n' "$diff" | grep -E '^\+\+\+ b/' | sed -E 's#^\+\+\+ b/##' || true)
  local found=0
  for excluded in "${EXCLUDED_PATHS[@]}"; do
    if printf '%s\n' "$touched" | grep -qxF "$excluded"; then
      check_fail "Diff touches excluded path: $excluded"
      found=1
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    check_pass "No excluded paths touched"
  fi
}

check_leak_patterns() {
  local diff="$1"
  if [[ ! -r "$PATTERNS_FILE" ]]; then
    echo "Leak pattern file not found or unreadable: $PATTERNS_FILE" >&2
    exit 1
  fi
  local added
  added=$(printf '%s\n' "$diff" | grep -E '^\+' | grep -Ev '^\+\+\+' || true)
  local found=0
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    [[ "$pattern" == \#* ]] && continue
    local matches
    matches=$(printf '%s\n' "$added" | grep -En "$pattern" || true)
    if [[ -n "$matches" ]]; then
      check_fail "Leak pattern matched: $pattern"
      printf '%s\n' "$matches" | sed 's/^/        /'
      found=1
    fi
  done < "$PATTERNS_FILE"
  if [[ "$found" -eq 0 ]]; then
    check_pass "No leak patterns matched"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo ""
echo "verify-public-diff — Incremental Sync Leak Check"
echo "=================================================="
echo ""
echo "Checking: $PUBLIC_CLONE_DIR"
echo ""

require_public_clone
require_not_main
fetch_origin
DIFF="$(compute_diff)"

check_excluded_paths "$DIFF"
check_leak_patterns "$DIFF"

echo ""
if [[ "$errors" -gt 0 ]]; then
  echo "  $errors check(s) failed. Fix before pushing."
  echo ""
  exit 1
fi
echo "  All checks passed. Safe to push."
echo ""
