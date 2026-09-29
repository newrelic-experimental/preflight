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
version="$(cd "$repo" && node -p "require('./package.json').devDependencies['@playwright/test']")"
# The image tag is the exact version; a range like ^1.62.1 has no image.
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "@playwright/test must be pinned to an exact version, got '$version'" >&2
  exit 1
fi
image="mcr.microsoft.com/playwright:v${version}-noble"

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
  rm -f /src/e2e/*-snapshots/*-linux.png
  for f in e2e/*-snapshots/*-linux.png; do mkdir -p "/src/$(dirname "$f")" && cp "$f" "/src/$f"; done
'

echo "Recorded in $image:"
(cd "$repo" && git status --short -- 'e2e/*-snapshots/*-linux.png')
