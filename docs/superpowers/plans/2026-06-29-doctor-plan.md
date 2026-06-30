# preflight doctor — Configuration Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `preflight doctor` CLI command, `GET /api/diagnostics` API route, startup error pointer, and a System Health panel in the Settings UI that together surface configuration problems with actionable fix instructions.

**Architecture:** A new `src/install/diagnostics.ts` module owns all six checks and is imported by both the CLI (`src/install/cli.ts`) and the API handler (`src/dashboard/routes/api-handler.ts`). The UI fetches `/api/diagnostics` every 30 s and renders a compact health panel at the top of the Settings view. Config load errors at startup are caught and re-thrown with a pointer to `preflight doctor`.

**Tech Stack:** TypeScript/ESM, Node.js `fs`/`os`/`path` built-ins, native `fetch` (Node 18+), React + TanStack Query (UI), Jest (unit tests), Vitest (web tests).

## Global Constraints

- ESM throughout — all imports use `.js` extensions.
- Zero ESLint errors or warnings — never use `eslint-disable` or `as any`.
- `src/shared/` is vendored — do not edit.
- Files under `src/web/` use Vitest (`vi.spyOn`, `@testing-library/react`); files under `src/` use Jest (`jest.mock`, `@jest/globals`).
- Web test files must end in `.test.tsx` (not `.test.ts`) — Jest picks up `.test.ts` and fails on Vitest imports.
- Run `npm run build && npm test` before committing each task.
- Commit message format: `Type: Short description` + `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.

---

## File Map

| Action     | Path                                       | Responsibility                            |
| ---------- | ------------------------------------------ | ----------------------------------------- |
| **Create** | `src/install/diagnostics.ts`               | `runDiagnostics()` — all 6 checks         |
| **Create** | `src/install/diagnostics.test.ts`          | Jest unit tests for all checks            |
| **Modify** | `src/install/cli.ts`                       | Add `preflight doctor` subcommand         |
| **Modify** | `src/install/cli.test.ts`                  | Test `doctor` command output + exit codes |
| **Modify** | `src/index.ts`                             | Startup config-load error pointer         |
| **Modify** | `src/dashboard/routes/api-handler.ts`      | Add `GET /api/diagnostics` route          |
| **Modify** | `src/dashboard/routes/api-handler.test.ts` | Test the new route                        |
| **Modify** | `src/web/api/client.ts`                    | Add `fetchDiagnostics` + `qk.diagnostics` |
| **Modify** | `src/web/views/Settings.tsx`               | Add `DiagnosticsPanel` component at top   |
| **Create** | `src/web/views/Settings.test.tsx`          | Vitest tests for `DiagnosticsPanel`       |

---

## Task 1: Core diagnostics module

**Files:**

- Create: `src/install/diagnostics.ts`
- Create: `src/install/diagnostics.test.ts`

**Interfaces:**

- Produces: `DiagnosticCheck` interface + `runDiagnostics(opts?)` async function — consumed by Tasks 2, 4.

- [ ] **Step 1: Write the failing tests**

Create `src/install/diagnostics.test.ts`:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { resolve } from 'node:path';

// Suppress logger output.
jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

// Mock all fs I/O so tests are hermetic.
jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    accessSync: jest.fn(),
    constants: real.constants,
  };
});

// Point homedir at a stable test path.
jest.mock('node:os', () => {
  const real = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...real, homedir: () => '/test-home', platform: jest.fn(() => 'darwin') };
});

// Stub schedule module.
jest.mock('./schedule.js', () => ({
  getDashboardDaemonStatus: jest.fn(() => ({ installed: false })),
}));

// Stub config module.
jest.mock('../config.js', () => ({
  validateConfigFile: jest.fn(() => ({ fileExists: false, errors: [], warnings: [] })),
  DEFAULT_STORAGE_PATH: '/test-home/.newrelic-preflight',
}));

// Stub install-helper.
jest.mock('./install-helper.js', () => ({
  detectSettingsPath: jest.fn(() => '/test-home/.claude/settings.json'),
}));

// Stub global fetch.
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch as unknown as typeof fetch;

import type { DiagnosticCheck } from './diagnostics.js';
import * as schedule from './schedule.js';
import * as config from '../config.js';
import * as installHelper from './install-helper.js';

const mockedExistSync = nodeFs.existsSync as jest.Mock;
const mockedReadFileSync = nodeFs.readFileSync as jest.Mock;
const mockedAccessSync = nodeFs.accessSync as jest.Mock;
const mockedPlatform = nodeOs.platform as jest.Mock;
const mockedGetDaemonStatus = schedule.getDashboardDaemonStatus as jest.Mock;
const mockedValidateConfig = config.validateConfigFile as jest.Mock;
const mockedDetectSettingsPath = installHelper.detectSettingsPath as jest.Mock;

function makeOpts() {
  return {
    configPath: '/test-home/.newrelic-preflight/config.json',
    storagePath: '/test-home/.newrelic-preflight',
  };
}

describe('runDiagnostics', () => {
  let runDiagnostics: (opts?: {
    configPath?: string;
    storagePath?: string;
  }) => Promise<DiagnosticCheck[]>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedPlatform.mockReturnValue('darwin');
    mockedExistSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue('{}');
    mockedAccessSync.mockImplementation(() => undefined);
    mockedGetDaemonStatus.mockReturnValue({ installed: false });
    mockedValidateConfig.mockReturnValue({ fileExists: false, errors: [], warnings: [] });
    mockedDetectSettingsPath.mockReturnValue('/test-home/.claude/settings.json');
    mockFetch.mockResolvedValue({ ok: true } as Response);

    const mod = await import('./diagnostics.js');
    runDiagnostics = mod.runDiagnostics;
  });

  describe('Check 1: Config valid', () => {
    it('returns warn when config file does not exist', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: false, errors: [], warnings: [] });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
      expect(c.fix).toBe('preflight setup');
    });

    it('returns fail when config has errors', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        errors: ['mode: bad value'],
        warnings: [],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('mode: bad value');
    });

    it('returns warn when config has warnings only', async () => {
      mockedValidateConfig.mockReturnValue({
        fileExists: true,
        errors: [],
        warnings: ['Unknown key "foo"'],
      });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('warn');
    });

    it('returns ok when config is valid', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: true, errors: [], warnings: [] });
      const checks = await runDiagnostics(makeOpts());
      const c = checks.find((x) => x.check === 'Config valid')!;
      expect(c.status).toBe('ok');
    });
  });

  describe('Check 2: Daemon installed', () => {
    it('returns skip on non-macOS', async () => {
      mockedPlatform.mockReturnValue('linux');
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('skip');
    });

    it('returns fail when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('fail');
    });

    it('returns ok when daemon is installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        '<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>',
      );
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon installed')?.status).toBe('ok');
    });
  });

  describe('Check 3: Daemon node path', () => {
    it('returns skip when daemon not installed', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: false });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('skip');
    });

    it('returns ok when node dir is in plist PATH', async () => {
      const nodeDir = resolve(process.execPath, '..');
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(`<key>PATH</key><string>${nodeDir}:/usr/bin</string>`);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('ok');
    });

    it('returns fail when node dir is missing from plist PATH', async () => {
      mockedGetDaemonStatus.mockReturnValue({ installed: true });
      mockedExistSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        '<key>PATH</key><string>/some/other/bin:/usr/bin</string>',
      );
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Daemon node path')?.status).toBe('fail');
    });
  });

  describe('Check 4: Hooks wired', () => {
    it('returns fail when settings file does not exist', async () => {
      mockedExistSync.mockImplementation((p) => p !== '/test-home/.claude/settings.json');
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('fail');
    });

    it('returns fail when hooks are missing', async () => {
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json') return JSON.stringify({ hooks: {} });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('fail');
    });

    it('returns ok when both PreToolUse and PostToolUse hooks are present', async () => {
      const hookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector pre-tool' }],
      };
      const postEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: 'preflight-collector post-tool' }],
      };
      mockedExistSync.mockImplementation((p) => p === '/test-home/.claude/settings.json');
      mockedReadFileSync.mockImplementation((p) => {
        if (p === '/test-home/.claude/settings.json')
          return JSON.stringify({ hooks: { PreToolUse: [hookEntry], PostToolUse: [postEntry] } });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Hooks wired')?.status).toBe('ok');
    });
  });

  describe('Check 5: Storage writable', () => {
    it('returns fail when directory does not exist', async () => {
      mockedExistSync.mockImplementation((p) => p !== '/test-home/.newrelic-preflight');
      mockedAccessSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('fail');
    });

    it('returns fail when directory is not writable', async () => {
      mockedExistSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        throw new Error('EACCES');
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('fail');
    });

    it('returns ok when directory is writable', async () => {
      mockedExistSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => undefined);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'Storage writable')?.status).toBe('ok');
    });
  });

  describe('Check 6: NR reachable', () => {
    it('returns skip when mode is local', async () => {
      mockedValidateConfig.mockReturnValue({ fileExists: true, errors: [], warnings: [] });
      mockedReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('config.json')) return JSON.stringify({ mode: 'local' });
        return '{}';
      });
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'NR reachable')?.status).toBe('skip');
    });

    it('returns ok when fetch succeeds', async () => {
      mockFetch.mockResolvedValue({ ok: true } as Response);
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'NR reachable')?.status).toBe('ok');
    });

    it('returns fail when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      const checks = await runDiagnostics(makeOpts());
      expect(checks.find((x) => x.check === 'NR reachable')?.status).toBe('fail');
    });
  });

  it('returns exactly 6 checks on macOS', async () => {
    const checks = await runDiagnostics(makeOpts());
    expect(checks).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest -- src/install/diagnostics.test.ts 2>&1 | tail -5
```

Expected: FAIL — `Cannot find module './diagnostics.js'`

- [ ] **Step 3: Create `src/install/diagnostics.ts`**

```typescript
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';

import { validateConfigFile, DEFAULT_STORAGE_PATH } from '../config.js';
import { getDashboardDaemonStatus } from './schedule.js';
import { detectSettingsPath } from './install-helper.js';

export interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
}

const DASHBOARD_PLIST_PATH = resolve(
  homedir(),
  'Library',
  'LaunchAgents',
  'com.preflight.dashboard.plist',
);

// Matches both bare-name and absolute-path hook commands written by preflight install.
const NR_HOOK_RE = /preflight-collector"?\s+(?:pre|post)-tool/;

function entryHasNrHook(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  if (Array.isArray(obj.hooks)) {
    return obj.hooks.some(
      (h: unknown) =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as Record<string, unknown>).command === 'string' &&
        NR_HOOK_RE.test((h as Record<string, unknown>).command as string),
    );
  }
  if (typeof obj.command === 'string') return NR_HOOK_RE.test(obj.command);
  return false;
}

export async function runDiagnostics(opts?: {
  configPath?: string;
  storagePath?: string;
}): Promise<DiagnosticCheck[]> {
  const configPath = opts?.configPath ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const storagePath = opts?.storagePath ?? DEFAULT_STORAGE_PATH;
  const checks: DiagnosticCheck[] = [];

  // --- Check 1: Config valid ---
  const validation = validateConfigFile(configPath);
  if (!validation.fileExists) {
    checks.push({
      check: 'Config valid',
      status: 'warn',
      detail: `No config file at ${configPath} — defaults will apply.`,
      fix: 'preflight setup',
    });
  } else if (validation.errors.length > 0) {
    checks.push({
      check: 'Config valid',
      status: 'fail',
      detail: validation.errors.join('; '),
      fix: 'Fix the fields listed above, then restart.',
    });
  } else if (validation.warnings.length > 0) {
    checks.push({
      check: 'Config valid',
      status: 'warn',
      detail: validation.warnings.join('; '),
    });
  } else {
    checks.push({
      check: 'Config valid',
      status: 'ok',
      detail: `Config loaded from ${configPath}`,
    });
  }

  // Determine mode for check 6 (NR reachability).
  let mode = 'cloud';
  if (validation.fileExists && validation.errors.length === 0) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (typeof parsed.mode === 'string') mode = parsed.mode;
    } catch {
      /* keep default */
    }
  }

  // --- Checks 2 + 3: Daemon (macOS only) ---
  if (platform() !== 'darwin') {
    checks.push({
      check: 'Daemon installed',
      status: 'skip',
      detail: 'Daemon management is macOS-only.',
    });
    checks.push({
      check: 'Daemon node path',
      status: 'skip',
      detail: 'Daemon management is macOS-only.',
    });
  } else {
    const daemonStatus = getDashboardDaemonStatus();
    if (!daemonStatus.installed) {
      checks.push({
        check: 'Daemon installed',
        status: 'fail',
        detail: 'com.preflight.dashboard.plist not found in ~/Library/LaunchAgents/',
        fix: 'preflight install --daemon',
      });
      checks.push({
        check: 'Daemon node path',
        status: 'skip',
        detail: 'Daemon not installed — install first.',
      });
    } else {
      checks.push({
        check: 'Daemon installed',
        status: 'ok',
        detail: 'com.preflight.dashboard.plist found',
      });

      // --- Check 3: Daemon node path ---
      try {
        const plistContent = readFileSync(DASHBOARD_PLIST_PATH, 'utf-8');
        const pathMatch = plistContent.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
        const plistPathValue = pathMatch ? pathMatch[1] : '';
        const plistDirs = plistPathValue.split(':');
        const nodeDir = dirname(process.execPath);
        if (plistDirs.includes(nodeDir)) {
          checks.push({
            check: 'Daemon node path',
            status: 'ok',
            detail: `${nodeDir} in plist PATH`,
          });
        } else {
          checks.push({
            check: 'Daemon node path',
            status: 'fail',
            detail: `Node directory ${nodeDir} missing from plist PATH`,
            fix: 'preflight install --daemon',
          });
        }
      } catch {
        checks.push({
          check: 'Daemon node path',
          status: 'warn',
          detail: 'Could not read plist to verify node path',
          fix: 'preflight install --daemon',
        });
      }
    }
  }

  // --- Check 4: Hooks wired ---
  const settingsPath = detectSettingsPath('user');
  let hooksPre = false;
  let hooksPost = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (Array.isArray(hooks?.PreToolUse)) hooksPre = hooks.PreToolUse.some(entryHasNrHook);
      if (Array.isArray(hooks?.PostToolUse)) hooksPost = hooks.PostToolUse.some(entryHasNrHook);
    } catch {
      /* treat as not wired */
    }
  }
  if (!hooksPre || !hooksPost) {
    const missing = [!hooksPre && 'PreToolUse', !hooksPost && 'PostToolUse']
      .filter(Boolean)
      .join(' and ');
    checks.push({
      check: 'Hooks wired',
      status: 'fail',
      detail: `${missing} not found in ${settingsPath}`,
      fix: 'preflight install',
    });
  } else {
    checks.push({
      check: 'Hooks wired',
      status: 'ok',
      detail: 'PreToolUse and PostToolUse hooks found',
    });
  }

  // --- Check 5: Storage writable ---
  try {
    accessSync(storagePath, constants.W_OK);
    checks.push({
      check: 'Storage writable',
      status: 'ok',
      detail: `${storagePath} is writable`,
    });
  } catch {
    if (!existsSync(storagePath)) {
      checks.push({
        check: 'Storage writable',
        status: 'fail',
        detail: `Directory not found: ${storagePath}`,
        fix: `mkdir -p ${storagePath} && chmod 700 ${storagePath}`,
      });
    } else {
      checks.push({
        check: 'Storage writable',
        status: 'fail',
        detail: `Directory exists but is not writable: ${storagePath}`,
        fix: `chmod 700 ${storagePath}`,
      });
    }
  }

  // --- Check 6: NR reachable ---
  if (mode === 'local') {
    checks.push({
      check: 'NR reachable',
      status: 'skip',
      detail: 'Skipped (mode: local)',
    });
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch('https://insights-collector.newrelic.com', {
        method: 'HEAD',
        signal: controller.signal,
      });
      checks.push({
        check: 'NR reachable',
        status: 'ok',
        detail: 'insights-collector.newrelic.com reachable',
      });
    } catch {
      checks.push({
        check: 'NR reachable',
        status: 'fail',
        detail: 'Could not reach insights-collector.newrelic.com',
        fix: 'Check network connectivity and that licenseKey is valid.',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return checks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest -- src/install/diagnostics.test.ts 2>&1 | tail -5
```

Expected: PASS — 18 tests passing

- [ ] **Step 5: Build and lint**

```bash
npm run build 2>&1 | grep -E "error TS" | head -5
npm run lint 2>&1 | tail -5
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/install/diagnostics.ts src/install/diagnostics.test.ts
git commit -m "$(cat <<'EOF'
Feat: add runDiagnostics() — 6-check configuration health module

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `preflight doctor` CLI subcommand

**Files:**

- Modify: `src/install/cli.ts` (add `handleDoctor` + register `doctor` command)
- Modify: `src/install/cli.test.ts` (add doctor tests)

**Interfaces:**

- Consumes: `runDiagnostics(opts?)` from `./diagnostics.js` (Task 1)
- Produces: `preflight doctor` subcommand with exit codes 0/1/2

- [ ] **Step 1: Write the failing tests**

Open `src/install/cli.test.ts`. Locate the existing mock block at the top of the file (it mocks `./schedule.js`, `../config.js`, etc.). Add the `diagnostics.js` mock alongside the existing mocks:

```typescript
// Add to the existing jest.mock block area in cli.test.ts:
jest.mock('./diagnostics.js', () => ({
  runDiagnostics: jest.fn(async () => []),
}));
```

Then add this test suite anywhere after the existing suites:

```typescript
import type { DiagnosticCheck } from './diagnostics.js';
import * as diagnostics from './diagnostics.js';

const mockedRunDiagnostics = diagnostics.runDiagnostics as jest.Mock;

describe('preflight doctor', () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    jest.clearAllMocks();
  });

  function makeCheck(overrides: Partial<DiagnosticCheck>): DiagnosticCheck {
    return {
      check: 'Config valid',
      status: 'ok',
      detail: 'Config loaded',
      ...overrides,
    };
  }

  it('prints "All checks passed" and exits 0 when all checks pass', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'ok' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('All checks passed');
    expect(process.exitCode).toBeFalsy();
  });

  it('sets exit code 1 when a check fails', async () => {
    mockedRunDiagnostics.mockResolvedValue([
      makeCheck({ status: 'fail', detail: 'bad', fix: 'preflight install' }),
    ]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(process.exitCode).toBe(1);
  });

  it('sets exit code 2 when only warnings', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'warn', detail: 'mild' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(process.exitCode).toBe(2);
  });

  it('prints fix instructions for failing checks', async () => {
    mockedRunDiagnostics.mockResolvedValue([
      makeCheck({
        check: 'Hooks wired',
        status: 'fail',
        detail: 'missing',
        fix: 'preflight install',
      }),
    ]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('preflight install');
  });

  it('prints skip checks with a dash', async () => {
    mockedRunDiagnostics.mockResolvedValue([makeCheck({ status: 'skip', detail: 'macOS only' })]);
    const { createInstallProgram } = await import('./cli.js');
    const prog = createInstallProgram();
    await prog.parseAsync(['node', 'preflight', 'doctor']);
    expect(output.join('')).toContain('-');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest -- src/install/cli.test.ts 2>&1 | grep "preflight doctor" | head -5
```

Expected: FAIL — `preflight doctor` suite errors

- [ ] **Step 3: Add `handleDoctor` and register the subcommand in `src/install/cli.ts`**

Add the handler after `handleValidate` (around line 660 in the current file):

```typescript
async function handleDoctor(options: { config?: string }): Promise<void> {
  const { runDiagnostics } = await import('./diagnostics.js');
  const configPath = options.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');

  print('Running diagnostics...\n');
  const checks = await runDiagnostics({ configPath });

  const ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✗', skip: '-' };
  const COL = 22;

  for (const c of checks) {
    const icon = ICON[c.status] ?? '?';
    print(`${icon} ${c.check.padEnd(COL)} ${c.detail}`);
    if (c.fix && (c.status === 'fail' || c.status === 'warn')) {
      print(`  ${' '.repeat(COL)}Fix: ${c.fix}`);
    }
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  print('');
  if (fails === 0 && warns === 0) {
    print('✓ All checks passed.');
    return;
  }

  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} failure${fails > 1 ? 's' : ''}`);
  if (warns > 0) parts.push(`${warns} warning${warns > 1 ? 's' : ''}`);
  print(`${parts.join(', ')} found. Run the fix commands above, then restart.`);

  process.exitCode = fails > 0 ? 1 : 2;
}
```

Then register the command inside `createInstallProgram()`, after the `validate` command block:

```typescript
program
  .command('doctor')
  .description('Check configuration, hooks, daemon, and connectivity for common setup problems')
  .option('--config <path>', 'Path to config file (default: ~/.newrelic-preflight/config.json)')
  .action(handleDoctor);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest -- src/install/cli.test.ts 2>&1 | tail -5
```

Expected: PASS — full suite green

- [ ] **Step 5: Build and lint**

```bash
npm run build 2>&1 | grep -E "error TS" | head -5
npm run lint 2>&1 | tail -5
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/install/cli.ts src/install/cli.test.ts
git commit -m "$(cat <<'EOF'
Feat: add preflight doctor subcommand with 6-check diagnostic output

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Startup error pointer

**Files:**

- Modify: `src/index.ts` (wrap `loadMcpConfig` calls to append pointer on error)

**Interfaces:**

- Consumes: existing `loadMcpConfig` from `./config.js`
- Produces: config load errors include "Run 'preflight doctor' to diagnose."

- [ ] **Step 1: Add the wrapper function**

In `src/index.ts`, find the imports block near the top (around line 10 where `loadMcpConfig` is imported). After the existing import, add this helper function in the module body (not inside `main`), near the other top-level helpers:

```typescript
function loadConfigOrDie(options: Partial<CliOptions>): Readonly<McpServerConfig> {
  try {
    return loadMcpConfig(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n\nRun 'preflight doctor' to diagnose.`);
  }
}
```

- [ ] **Step 2: Replace `loadMcpConfig(options)` calls at startup**

There are two startup calls to replace (the `--stdio` path and the `--local` path). Search for:

```typescript
config = loadMcpConfig(options);
```

and replace **both occurrences** (the one inside the `if (options.stdio)` branch around line 607 and the one inside the `else` / `--local` branch around line 648) with:

```typescript
config = loadConfigOrDie(options);
```

Do **not** replace the call inside the `--validate` block (around line 478) — that path intentionally shows the raw error to the user.

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | grep -E "error TS" | head -5
```

Expected: no TypeScript errors

- [ ] **Step 4: Lint**

```bash
npm run lint 2>&1 | tail -5
```

Expected: no errors

- [ ] **Step 5: Run the test suite to check for regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
Feat: append preflight doctor pointer to config load errors at startup

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: API route and client

**Files:**

- Modify: `src/dashboard/routes/api-handler.ts` (add `GET /api/diagnostics`)
- Modify: `src/dashboard/routes/api-handler.test.ts` (add route test)
- Modify: `src/web/api/client.ts` (add `fetchDiagnostics` + `qk.diagnostics`)

**Interfaces:**

- Consumes: `runDiagnostics()` from `../../install/diagnostics.js`
- Produces: `GET /api/diagnostics → DiagnosticCheck[]`; `fetchDiagnostics(): Promise<unknown>`; `qk.diagnostics` — consumed by Task 5.

- [ ] **Step 1: Write the failing API test**

Open `src/dashboard/routes/api-handler.test.ts`. The file already has a mock for the `diagnostics` module if you added one, otherwise add it near the top mock block:

```typescript
jest.mock('../../install/diagnostics.js', () => ({
  runDiagnostics: jest.fn(async () => [
    { check: 'Config valid', status: 'ok', detail: 'ok', fix: undefined },
  ]),
}));
```

Then add this test:

```typescript
import * as diagnosticsModule from '../../install/diagnostics.js';

const mockedRunDiagnostics = diagnosticsModule.runDiagnostics as jest.Mock;

describe('GET /api/diagnostics', () => {
  it('returns the DiagnosticCheck array from runDiagnostics', async () => {
    const expected = [{ check: 'Config valid', status: 'ok', detail: 'loaded', fix: undefined }];
    mockedRunDiagnostics.mockResolvedValue(expected);

    const { req, res, body, status } = makeReqRes('GET', '/api/diagnostics');
    await handler(req, res);

    expect(status()).toBe(200);
    expect(body()).toEqual(expected);
  });
});
```

Note: `makeReqRes` and `handler` are already defined in the test file — follow the existing pattern.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest -- src/dashboard/routes/api-handler.test.ts -t "GET /api/diagnostics" 2>&1 | tail -5
```

Expected: FAIL — route not found / 404

- [ ] **Step 3: Add the route in `src/dashboard/routes/api-handler.ts`**

Find the `GET /api/settings` route (around line 1293). Add the new route immediately before it:

```typescript
routes.set('GET /api/diagnostics', async (_req, res) => {
  const { runDiagnostics } = await import('../../install/diagnostics.js');
  const checks = await runDiagnostics({
    configPath: deps.configFilePath ?? undefined,
    storagePath: deps.config?.storagePath,
  });
  jsonOk(res, checks);
});
```

- [ ] **Step 4: Add client helpers in `src/web/api/client.ts`**

Find the `fetchSettings` line (around line 94) and add after it:

```typescript
export const fetchDiagnostics = (): Promise<unknown> => getJson<unknown>('/api/diagnostics');
```

Find the `qk` object and add `diagnostics` as the last entry before the closing `}`:

```typescript
  diagnostics: ['diagnostics'] as const,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest -- src/dashboard/routes/api-handler.test.ts 2>&1 | tail -5
```

Expected: PASS

- [ ] **Step 6: Build and lint**

```bash
npm run build 2>&1 | grep -E "error TS" | head -5
npm run lint 2>&1 | tail -5
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/api-handler.ts src/dashboard/routes/api-handler.test.ts src/web/api/client.ts
git commit -m "$(cat <<'EOF'
Feat: add GET /api/diagnostics route and fetchDiagnostics client helper

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Settings UI — DiagnosticsPanel

**Files:**

- Modify: `src/web/views/Settings.tsx` (add `DiagnosticsPanel` + render at top)
- Create: `src/web/views/Settings.test.tsx` (Vitest tests)

**Interfaces:**

- Consumes: `fetchDiagnostics` + `qk.diagnostics` from `../api/client` (Task 4)

- [ ] **Step 1: Write the failing tests**

Create `src/web/views/Settings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from './Settings.js';

vi.mock('../api/client', () => ({
  fetchSettings: vi.fn(async () => ({
    developer: 'dev',
    teamId: null,
    accountId: null,
    appName: 'preflight',
    mode: 'local',
    storagePath: '~/.newrelic-preflight',
    highSecurity: false,
    licenseKey: null,
    sessionBudgetUsd: null,
    dailyBudgetUsd: null,
    weeklyBudgetUsd: null,
    retainSessionsDays: null,
  })),
  fetchDiagnostics: vi.fn(async () => []),
  patchSettings: vi.fn(async () => ({})),
  qk: {
    settings: ['settings'],
    diagnostics: ['diagnostics'],
  },
}));

import * as client from '../api/client';

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('DiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "System healthy" when all checks are ok', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      { check: 'Config valid', status: 'ok', detail: 'Config loaded' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/system healthy/i)).toBeTruthy();
  });

  it('renders failing check name and detail when a check fails', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      {
        check: 'Hooks wired',
        status: 'fail',
        detail: 'PreToolUse missing',
        fix: 'preflight install',
      },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/Hooks wired/)).toBeTruthy();
    expect(await screen.findByText(/PreToolUse missing/)).toBeTruthy();
    expect(await screen.findByText(/preflight install/)).toBeTruthy();
  });

  it('renders warning check with amber indicator', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      { check: 'Config valid', status: 'warn', detail: 'Unknown key "foo"' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/Unknown key/)).toBeTruthy();
  });

  it('renders skip checks with a dash indicator', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      { check: 'Daemon installed', status: 'skip', detail: 'macOS only' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/macOS only/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/web/views/Settings.test.tsx 2>&1 | tail -5
```

Expected: FAIL — `DiagnosticsPanel` not found / import error

- [ ] **Step 3: Add `DiagnosticsPanel` to `src/web/views/Settings.tsx`**

Add these imports at the top of `Settings.tsx` alongside the existing imports:

```typescript
import { useQuery } from '@tanstack/react-query';
import { fetchDiagnostics, qk } from '../api/client';
```

(Note: `useQuery` and `useMutation` are already imported — only add `fetchDiagnostics` and `qk` to the existing client import line.)

Add the `DiagnosticCheck` interface and the component before the `export function Settings()` declaration:

```tsx
interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
}

const STATUS_ICON: Record<string, string> = {
  ok: '●',
  warn: '▲',
  fail: '✗',
  skip: '–',
};

const STATUS_COLOR: Record<string, string> = {
  ok: 'text-accent-green',
  warn: 'text-accent-amber',
  fail: 'text-accent-red',
  skip: 'text-ink-muted',
};

function DiagnosticsPanel(): JSX.Element {
  const { data, isLoading, refetch } = useQuery<DiagnosticCheck[]>({
    queryKey: qk.diagnostics,
    queryFn: () => fetchDiagnostics() as Promise<DiagnosticCheck[]>,
    refetchInterval: 30_000,
  });

  const checks = data ?? [];
  const hasIssues = checks.some((c) => c.status === 'fail' || c.status === 'warn');

  return (
    <Card padding="md" className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <SectionHeader title="System Health" />
        <button
          onClick={() => void refetch()}
          className="text-[10px] text-ink-muted hover:text-ink-base transition-colors"
        >
          Re-check
        </button>
      </div>

      {isLoading && <EmptyState icon="clock" variant="loading" title="Checking system…" />}

      {!isLoading && !hasIssues && checks.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-accent-green">
          <span>●</span>
          <span>System healthy</span>
        </div>
      )}

      {!isLoading && hasIssues && (
        <div className="space-y-1.5">
          {checks.map((c) => (
            <div key={c.check}>
              <div className="flex items-baseline gap-2 text-xs">
                <span className={`shrink-0 ${STATUS_COLOR[c.status] ?? 'text-ink-muted'}`}>
                  {STATUS_ICON[c.status] ?? '?'}
                </span>
                <span className="text-ink-muted w-36 shrink-0">{c.check}</span>
                <span className="text-ink-subtle">{c.detail}</span>
              </div>
              {c.fix && (c.status === 'fail' || c.status === 'warn') && (
                <div className="ml-[1.25rem] mt-0.5 flex items-center gap-2">
                  <span className="text-[10px] font-mono text-ink-subtle bg-surface-3 px-1.5 py-0.5 rounded">
                    {c.fix}
                  </span>
                  <button
                    className="text-[10px] text-ink-muted hover:text-ink-base transition-colors"
                    onClick={() => void navigator.clipboard.writeText(c.fix ?? '')}
                  >
                    copy
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
```

Then inside `export function Settings()`, render `<DiagnosticsPanel />` as the very first child of the returned `<section>`, before the `<header>` block:

```tsx
  return (
    <section>
      <DiagnosticsPanel />
      <header className="mb-6">
        ...
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/web/views/Settings.test.tsx 2>&1 | tail -5
```

Expected: PASS — 4 tests

- [ ] **Step 5: Build, lint, and full test suite**

```bash
npm run build 2>&1 | grep -E "error TS" | head -5
npm run lint 2>&1 | tail -5
npm test 2>&1 | tail -10
```

Expected: no errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/web/views/Settings.tsx src/web/views/Settings.test.tsx
git commit -m "$(cat <<'EOF'
Feat: add DiagnosticsPanel to Settings UI — System Health section

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```
