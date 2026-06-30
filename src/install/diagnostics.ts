import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';

import { validateConfigFile, DEFAULT_STORAGE_PATH } from '../config.js';
import { getDashboardDaemonStatus } from './schedule.js';
import { detectSettingsPath, entryContainsNrObserve } from './install-helper.js';
import { isWsl, resolveWindowsHome } from './platform.js';
import { readJsonFile } from './json-utils.js';

export interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
}

export async function runDiagnostics(opts?: {
  configPath?: string;
  storagePath?: string;
}): Promise<DiagnosticCheck[]> {
  const configPath = opts?.configPath ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const storagePath = opts?.storagePath ?? DEFAULT_STORAGE_PATH;
  const checks: DiagnosticCheck[] = [];

  // Pre-read config once for mode detection; validateConfigFile also reads internally.
  const configRaw = readJsonFile(configPath);
  const mode = typeof configRaw.mode === 'string' ? configRaw.mode : 'cloud';

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
        const plistFilePath = resolve(
          homedir(),
          'Library',
          'LaunchAgents',
          'com.preflight.dashboard.plist',
        );
        const plistContent = readFileSync(plistFilePath, 'utf-8');
        const pathMatch = plistContent.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
        const plistPathValue = pathMatch ? pathMatch[1] : '';
        const stripTrailingSlash = (p: string) => p.replace(/\/+$/, '');
        const plistDirs = plistPathValue.split(':').map(stripTrailingSlash);
        const nodeDir = stripTrailingSlash(dirname(process.execPath));
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
  // On WSL with --windows-cc installs, hooks live on the Windows-side path.
  // Check both the Linux-side path and, when running under WSL, the Windows-side path.
  const settingsPaths: string[] = [detectSettingsPath('user')];
  if (isWsl()) {
    const winHome = resolveWindowsHome();
    if (winHome) settingsPaths.push(detectSettingsPath('user', winHome));
  }

  const anyPathExists = settingsPaths.some(existsSync);
  let hooksPre = false;
  let hooksPost = false;
  for (const sp of settingsPaths) {
    if (!existsSync(sp)) continue;
    try {
      const settings = JSON.parse(readFileSync(sp, 'utf-8')) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (Array.isArray(hooks?.PreToolUse))
        hooksPre ||= hooks.PreToolUse.some(entryContainsNrObserve);
      if (Array.isArray(hooks?.PostToolUse))
        hooksPost ||= hooks.PostToolUse.some(entryContainsNrObserve);
    } catch {
      /* treat as not wired */
    }
  }

  if (!anyPathExists) {
    checks.push({
      check: 'Hooks wired',
      status: 'fail',
      detail: `Settings file not found: ${settingsPaths.join(' or ')}`,
      fix: 'preflight install',
    });
  } else if (!hooksPre || !hooksPost) {
    const missing = [!hooksPre && 'PreToolUse', !hooksPost && 'PostToolUse']
      .filter(Boolean)
      .join(' and ');
    checks.push({
      check: 'Hooks wired',
      status: 'fail',
      detail: `${missing} not found in ${settingsPaths.filter(existsSync).join(' or ')}`,
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
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      checks.push({
        check: 'NR reachable',
        status: 'fail',
        detail: isTimeout
          ? 'Request timed out after 5 s — endpoint may be reachable but slow'
          : 'Could not reach insights-collector.newrelic.com',
        fix: isTimeout
          ? 'Check for a slow proxy or firewall blocking HTTPS.'
          : 'Check network connectivity and that licenseKey is valid.',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return checks;
}
