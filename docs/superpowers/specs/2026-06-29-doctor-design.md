# preflight doctor — Configuration Diagnostics Design

## Goal

Surface setup and configuration problems through a `preflight doctor` CLI command, a `GET /api/diagnostics` API endpoint, and a System Health panel in the Settings UI. Fatal startup errors gain a one-line pointer to `preflight doctor`.

## Architecture

A new pure-utility module `src/install/diagnostics.ts` owns all diagnostic logic and is imported by both the CLI (`src/install/cli.ts`) and the API handler (`src/dashboard/routes/api-handler.ts`). No tracker coupling. The UI component lives in `src/web/views/Settings.tsx`.

## Data Model

```typescript
// src/install/diagnostics.ts
export interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string; // shell command or plain instruction
}

export function runDiagnostics(opts?: {
  configPath?: string;
  storagePath?: string;
}): DiagnosticCheck[];
```

`opts` defaults: `configPath` → `~/.newrelic-preflight/config.json`, `storagePath` → `~/.newrelic-preflight/`.

## Checks

Executed in this order, returned as an array in the same order:

| #   | `check` label    | `status: 'fail'` condition                                                                                  | `fix` value                                                                  |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Config valid     | `validateConfigFile()` returns any errors                                                                   | `"Fix the fields listed above, then restart."` (errors embedded in `detail`) |
| 2   | Daemon installed | No plist at `~/Library/LaunchAgents/com.preflight.dashboard.plist`                                          | `"preflight install --daemon"`                                               |
| 3   | Daemon node path | Plist PATH doesn't include the directory of the active `node` binary                                        | `"preflight install --daemon"` (regenerates plist with correct PATH)         |
| 4   | Hooks wired      | `~/.claude/settings.json` missing PreToolUse **and** PostToolUse entries referencing `preflight`            | `"preflight install"`                                                        |
| 5   | Storage writable | `~/.newrelic-preflight/` doesn't exist or `fs.accessSync` with `W_OK` throws                                | `"mkdir -p ~/.newrelic-preflight && chmod 700 ~/.newrelic-preflight"`        |
| 6   | NR reachable     | HTTP HEAD to `https://insights-collector.newrelic.com` fails — **`status: 'skip'`** when `mode === 'local'` | `"Check network connectivity and that licenseKey is valid."`                 |

Check 3 (Daemon node path): reads the installed plist, extracts the PATH env entry, splits on `:`, and verifies that `path.dirname(process.execPath)` (the active node binary's directory) appears in the list. Only runs if check 2 passes (daemon installed).

Check 6 uses a 5-second timeout. On non-macOS platforms, checks 2 and 3 return `status: 'skip'` with `detail: 'Daemon management is macOS-only.'`

## CLI: `preflight doctor`

New subcommand in `src/install/cli.ts`. Output format:

```
Running diagnostics...

✓ Config valid          Config loaded from ~/.newrelic-preflight/config.json
✓ Daemon installed      com.preflight.dashboard.plist found
✓ Daemon node path      /opt/homebrew/bin in PATH
✗ Hooks wired           PreToolUse/PostToolUse not found in ~/.claude/settings.json
                        Fix: preflight install
⚠ Storage writable      Directory exists but permissions are 0o755 (expected 0o700)
                        Fix: chmod 700 ~/.newrelic-preflight
- NR reachable          Skipped (mode: local)

2 issues found. Run the fix commands above, then restart.
```

Exit codes:

- `0` — all checks ok or skip
- `1` — one or more checks fail
- `2` — one or more checks warn, no fails

The summary line is omitted when all checks pass: just prints `✓ All checks passed.`

## Startup pointer

In `src/index.ts`, the existing config parse error handler (the `throw new Error(...)` path in `loadMcpConfig`) gains a single appended sentence:

```
Config error: <original message>. Run 'preflight doctor' to diagnose.
```

No other changes to startup flow. Non-blocking degraded state (hooks not wired, NR unreachable) is not surfaced at startup.

## API: `GET /api/diagnostics`

New route in `src/dashboard/routes/api-handler.ts`:

```
GET /api/diagnostics → DiagnosticCheck[]
```

Calls `runDiagnostics({ configPath: deps.configFilePath, storagePath: deps.config?.storagePath })`. Returns `200` with the array. No new fields needed in `ApiHandlerDeps` — `configFilePath` and `config` are already present.

## UI: System Health panel

New `DiagnosticsPanel` component rendered at the top of `src/web/views/Settings.tsx`, above the Identity & Account card.

- Fetches `/api/diagnostics` on mount and every 30 seconds (`refetchInterval: 30_000`)
- **All ok/skip:** renders a compact single green row — `✓ System healthy` — with a small "Re-check" button
- **Any warn/fail:** renders one row per check:
  - Status icon: `●` green (ok), `▲` amber (warn), `✗` red (fail), `–` grey (skip)
  - Check name + detail text inline
  - If `fix` is present: indented fix string with a clipboard copy button
- "Re-check" button top-right manually calls `refetch()`
- Loading state: `<EmptyState icon="clock" variant="loading" title="Checking system…" />`
- Fetch error: `<div className="text-accent-red text-xs">Failed to load diagnostics.</div>`

## Testing

- `src/install/diagnostics.test.ts` — unit tests for each check using `jest.mock('node:fs')` and `jest.mock('node:child_process')`. One test per check covering ok, fail, and skip paths. Factory helper `makeDiagnosticsOpts()`.
- `src/dashboard/routes/api-handler.test.ts` — one test for `GET /api/diagnostics` returning mocked check array.
- `src/web/views/Settings.test.tsx` (Vitest) — tests for all-ok collapsed state, mixed warn/fail expanded state, loading state.
