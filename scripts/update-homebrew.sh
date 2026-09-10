#!/usr/bin/env bash
# update-homebrew.sh — Fetch the npm tarball for a given version, compute its
# sha256, and rewrite homebrew/Formula/preflight.rb in-place.
#
# Usage: scripts/update-homebrew.sh <version>
# Example: scripts/update-homebrew.sh 1.2.0
set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 1.1.0" >&2
  exit 1
fi

TARBALL_URL="https://registry.npmjs.org/@newrelic/preflight/-/preflight-${VERSION}.tgz"
REPO_ROOT="$(git rev-parse --show-toplevel)"
FORMULA_PATH="${REPO_ROOT}/homebrew/Formula/preflight.rb"
TMPFILE="$(mktemp /tmp/preflight-XXXXXX.tgz)"

trap 'rm -f "$TMPFILE"' EXIT

echo "Downloading ${TARBALL_URL}..."
curl -fsSL "$TARBALL_URL" -o "$TMPFILE"

SHA256="$(shasum -a 256 "$TMPFILE" | awk '{print $1}')"

echo "Version:  ${VERSION}"
echo "SHA-256:  ${SHA256}"

perl -i -pe "s|url \".*\"|url \"${TARBALL_URL}\"|" "$FORMULA_PATH"
perl -i -pe "s|sha256 \".*\"|sha256 \"${SHA256}\"|" "$FORMULA_PATH"

echo ""
echo "Updated: ${FORMULA_PATH}"
echo ""
echo "Next steps:"
echo "  1. Review:  cat homebrew/Formula/preflight.rb"
echo "  2. Copy to tap repo: cp homebrew/Formula/preflight.rb <path-to-homebrew-preflight>/Formula/preflight.rb"
echo "  3. In tap repo: git add Formula/preflight.rb && git commit -m 'preflight ${VERSION}' && git push"
