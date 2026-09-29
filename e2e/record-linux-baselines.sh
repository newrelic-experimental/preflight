#!/usr/bin/env bash
# Re-records the -linux screenshot baselines in the Playwright image CI's e2e job runs in,
# so they match CI's fonts and rasterizer rather than your desktop's. Run from anywhere
# with Docker running: `npm run test:e2e:update:linux`.
#
# The repo is copied into the container, minus host build output and node_modules (which
# may hold another platform's native binaries), and only the -linux PNGs are copied back.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$repo/package.json').devDependencies['@playwright/test']")"
image="mcr.microsoft.com/playwright:v${version}-noble"

# linux/amd64 is what ubuntu-latest runs; on Apple Silicon this runs emulated, slower but
# pixel-identical to CI.
docker run --rm --platform linux/amd64 -v "$repo":/src "$image" bash -c '
  set -euo pipefail
  mkdir /work
  tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./.git \
    --exclude="*.tsbuildinfo" --exclude=./test-results --exclude=./playwright-report \
    -cf - . | tar -C /work -xf -
  cd /work
  npm ci --no-audit --no-fund
  rm -f e2e/*-snapshots/*-linux.png
  npm run test:e2e:update
  for f in e2e/*-snapshots/*-linux.png; do cp "$f" "/src/$f"; done
'

echo "Recorded in $image:"
(cd "$repo" && git status --short -- 'e2e/*-snapshots/*-linux.png')
