#!/usr/bin/env bash
# Re-records the -linux screenshot baselines in the Playwright image CI's e2e job runs in,
# so they match CI's fonts and rasterizer rather than your desktop's. Run from anywhere
# with Docker running: `npm run test:e2e:update:linux`.
#
# The repo is copied into the container, minus host build output and node_modules (which
# may hold another platform's native binaries). On success the host's -linux PNGs are
# replaced by the recorded set, so a baseline whose test was renamed or removed goes too.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# The image CI's e2e job declares, read from ci.yml rather than rebuilt here, so the two can
# never disagree. CI's own first step checks that tag against @playwright/test.
image="$(sed -n 's/^ *image: *\(mcr\.microsoft\.com\/playwright:[^ ]*\)$/\1/p' "$repo/.github/workflows/ci.yml")"
if [[ -z "$image" || "$image" == *$'\n'* ]]; then
  echo "expected exactly one mcr.microsoft.com/playwright image in .github/workflows/ci.yml" >&2
  exit 1
fi

# linux/amd64 is what ubuntu-latest runs; on Apple Silicon this runs emulated, slower but
# pixel-identical to CI. Running as the host user keeps the PNGs it writes owned by you on
# a Linux host; HOME points npm's cache somewhere that user can write.
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$repo":/src "$image" bash -c '
  set -euo pipefail
  mkdir /tmp/work
  tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./.git \
    --exclude="*.tsbuildinfo" --exclude=./test-results --exclude=./playwright-report \
    -cf - . | tar -C /tmp/work -xf -
  cd /tmp/work
  npm ci --no-audit --no-fund
  rm -f e2e/*-snapshots/*-linux.png
  npm run test:e2e:update
  # Only reached when the suite passed (set -e), so the recorded set is complete, even when
  # it is empty because the last screenshot test was removed: replace the host set with it.
  shopt -s nullglob
  recorded=(e2e/*-snapshots/*-linux.png)
  rm -f /src/e2e/*-snapshots/*-linux.png
  for f in "${recorded[@]}"; do mkdir -p "/src/$(dirname "$f")" && cp "$f" "/src/$f"; done
'

echo "Recorded in $image:"
(cd "$repo" && git status --short -- 'e2e/*-snapshots/*-linux.png')
