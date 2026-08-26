#!/usr/bin/env bash
# Checks that the binaries this power's mcp.json and hooks depend on are
# resolvable on PATH. Neither can be bundled inside the power itself (Kiro
# powers can't ship executables), so both come from a global npm install.
set -uo pipefail

missing=0
for bin in preflight preflight-collector; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "OK: $bin -> $(command -v "$bin")"
  else
    echo "MISSING: $bin not found on PATH"
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo
  echo "Run: npm install -g @newrelic/preflight"
  exit 1
fi

echo
echo "All Preflight binaries resolved."
