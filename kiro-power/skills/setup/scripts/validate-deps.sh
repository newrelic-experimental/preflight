#!/usr/bin/env bash
# Checks that preflight-collector is resolvable on PATH. It can't be bundled
# inside the power itself (Kiro powers can't ship executables) and, unlike
# the preflight MCP server (launched on demand via npx in mcp.json), it runs
# on every single tool call and can't be routed through npx — so it needs a
# global npm install.
set -uo pipefail

bin=preflight-collector
if command -v "$bin" >/dev/null 2>&1; then
  echo "OK: $bin -> $(command -v "$bin")"
else
  echo "MISSING: $bin not found on PATH"
  echo
  echo "Run: npm install -g @newrelic/preflight"
  exit 1
fi

echo
echo "Preflight binary resolved."
