import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';

import { createLogger } from '../shared/index.js';

import { validateConfigFile, DEFAULT_STORAGE_PATH } from '../config.js';
import { getDashboardDaemonStatus, findExecutableNodeDir } from './schedule.js';
import {
  detectSettingsPath,
  entryContainsNrObserve,
  entryHasAnyCommandHook,
} from './install-helper.js';
import { isWsl, resolveWindowsHome } from './platform.js';

const logger = createLogger('diagnostics');

export interface DiagnosticCheck {
  readonly check: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  readonly detail: string;
  readonly fix?: string;
}

// Context derived from the config check that downstream checks need.
type DiagnosticsContext = {
  readonly storagePath: string;
  // Non-null when the NR reachability check should be skipped; the string is
  // used verbatim as the skip detail so the message is accurate for each cause
  // (absent file, config errors, local mode, missing licenseKey).
  readonly nrSkipReason: string | null;
};

function checkConfigValid(
  configPath: string,
  runtimeStoragePath: string | undefined,
): { check: DiagnosticCheck; context: DiagnosticsContext } {
  const validation = validateConfigFile(configPath);
  // Prioritise the caller's runtime-resolved value (env-var-wins, matching
  // loadMcpConfig priority) over the file value so the Storage writable check
  // tests the same path the MCP server actually writes to. Falls back to the
  // file value, then the default. Use || (not ??) so an empty string is treated
  // like a missing value and falls through to the next tier.
  const storagePath = runtimeStoragePath || validation.storagePath || DEFAULT_STORAGE_PATH;
  const effectiveMode = validation.mode ?? 'cloud';
  const licenseKeyEnv = process.env.NEW_RELIC_LICENSE_KEY;
  // Use .trim() so a whitespace-only value (e.g. '   ') is treated as absent,
  // preventing a false-positive NR reachability result when the key is invalid.
  const hasLicenseKey = validation.hasLicenseKey || Boolean(licenseKeyEnv?.trim());
  // Only skip the NR check for structural problems (no file, or file is unparseable).
  // Zod type errors on unrelated fields do not affect reachability — the derived
  // effectiveMode and hasLicenseKey values below still hold even when other fields
  // fail validation, so the check can run and surface connectivity issues in parallel.
  const nrSkipReason = !validation.fileExists
    ? 'Skipped (no config file — run preflight setup first)'
    : validation.malformed
      ? 'Skipped (config could not be parsed — fix issues above first)'
      : effectiveMode === 'local'
        ? 'Skipped (mode: local)'
        : !hasLicenseKey
          ? licenseKeyEnv !== undefined
            ? 'Skipped (NEW_RELIC_LICENSE_KEY is set but empty or blank — add a valid key)'
            : 'Skipped (licenseKey not configured — set NEW_RELIC_LICENSE_KEY or add to config)'
          : null;

  let check: DiagnosticCheck;
  if (!validation.fileExists) {
    check = {
      check: 'Config valid',
      status: 'warn',
      detail: `No config file at ${configPath} — defaults will apply.`,
      fix: 'preflight setup',
    };
  } else if (validation.errors.length > 0) {
    check = {
      check: 'Config valid',
      status: 'fail',
      detail: validation.errors.join('; '),
      fix: 'Fix the fields listed above, then restart.',
    };
  } else if (validation.warnings.length > 0) {
    check = {
      check: 'Config valid',
      status: 'warn',
      detail: validation.warnings.join('; '),
    };
  } else {
    check = {
      check: 'Config valid',
      status: 'ok',
      detail: `Config loaded from ${configPath}`,
    };
  }

  return {
    check,
    context: { storagePath, nrSkipReason },
  };
}

function checkDaemon(): DiagnosticCheck[] {
  if (platform() !== 'darwin') {
    return [
      { check: 'Daemon installed', status: 'skip', detail: 'Daemon management is macOS-only.' },
      { check: 'Daemon node path', status: 'skip', detail: 'Daemon management is macOS-only.' },
    ];
  }

  const daemonStatus = getDashboardDaemonStatus();

  if (!daemonStatus.installed) {
    return [
      {
        check: 'Daemon installed',
        status: 'warn',
        detail:
          'com.preflight.dashboard.plist not found — dashboard will only run when Claude Code is open.',
        fix: 'preflight setup (optional: install the always-on background daemon)',
      },
      {
        check: 'Daemon node path',
        status: 'skip',
        detail: 'Daemon not installed — install first.',
      },
    ];
  }

  if (!daemonStatus.readable) {
    return [
      {
        check: 'Daemon installed',
        status: 'warn',
        detail: 'com.preflight.dashboard.plist found but could not be read',
        fix: 'preflight uninstall --daemon, then preflight setup (answer Y to the daemon prompt)',
      },
      {
        check: 'Daemon node path',
        status: 'skip',
        detail: 'Plist unreadable — daemon status could not be verified.',
      },
    ];
  }

  const installedCheck: DiagnosticCheck = {
    check: 'Daemon installed',
    status: 'ok',
    detail: 'com.preflight.dashboard.plist found',
  };

  if (!daemonStatus.envPath) {
    return [
      installedCheck,
      {
        check: 'Daemon node path',
        status: 'warn',
        detail: 'Daemon plist predates node-path injection — node upgrades may break it',
        fix: 'preflight uninstall --daemon, then preflight setup (answer Y to the daemon prompt)',
      },
    ];
  }

  const plistDirs = daemonStatus.envPath.split(':').filter(Boolean);
  const { dir: nodeDir, hasNonExecutable } = findExecutableNodeDir(plistDirs);

  let nodePathCheck: DiagnosticCheck;
  if (nodeDir !== null) {
    nodePathCheck = {
      check: 'Daemon node path',
      status: 'ok',
      detail: 'node binary found in plist PATH',
    };
  } else if (hasNonExecutable) {
    nodePathCheck = {
      check: 'Daemon node path',
      status: 'fail',
      detail: 'node binary found in plist PATH but is not executable',
      fix: 'Check node permissions (chmod +x <node>), or reinstall: preflight uninstall --daemon && preflight setup',
    };
  } else {
    nodePathCheck = {
      check: 'Daemon node path',
      status: 'fail',
      detail: 'No executable node binary found in plist PATH dirs',
      fix: 'preflight uninstall --daemon, then preflight setup (answer Y to the daemon prompt)',
    };
  }

  return [installedCheck, nodePathCheck];
}

function checkHooksWired(settingsPaths: string[]): DiagnosticCheck {
  const anyPathExists = settingsPaths.some(existsSync);
  let hooksPre = false;
  let hooksPost = false;
  let hooksPreAny = false;
  let hooksPostAny = false;
  const parseErrorPaths: string[] = [];
  let anyParsed = false;

  for (const sp of settingsPaths) {
    if (!existsSync(sp)) continue;
    try {
      const settings = JSON.parse(readFileSync(sp, 'utf-8')) as Record<string, unknown>;
      anyParsed = true;
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      if (Array.isArray(hooks?.PreToolUse)) {
        hooksPre ||= hooks.PreToolUse.some(entryContainsNrObserve);
        hooksPreAny ||= hooks.PreToolUse.some(entryHasAnyCommandHook);
      }
      if (Array.isArray(hooks?.PostToolUse)) {
        hooksPost ||= hooks.PostToolUse.some(entryContainsNrObserve);
        hooksPostAny ||= hooks.PostToolUse.some(entryHasAnyCommandHook);
      }
    } catch (err) {
      logger.debug('settings file could not be parsed — treating as not wired', { err, path: sp });
      parseErrorPaths.push(sp);
    }
  }

  if (!anyPathExists) {
    return {
      check: 'Hooks wired',
      status: 'fail',
      detail: `Settings file not found: ${settingsPaths.join(' or ')}`,
      fix: 'preflight install',
    };
  }

  if (hooksPre && hooksPost) {
    const malformedNote =
      parseErrorPaths.length > 0 ? `; ${parseErrorPaths.join(' and ')} could not be parsed` : '';
    return {
      check: 'Hooks wired',
      status: parseErrorPaths.length > 0 ? 'warn' : 'ok',
      detail: `PreToolUse and PostToolUse hooks found${malformedNote}`,
      ...(parseErrorPaths.length > 0 && {
        fix: 'Fix or delete the malformed file(s), then run: preflight install',
      }),
    };
  }

  if (!anyParsed) {
    const plural = parseErrorPaths.length > 1 ? 'files' : 'file';
    return {
      check: 'Hooks wired',
      status: 'fail',
      detail: `Settings ${plural} could not be parsed (malformed JSON): ${parseErrorPaths.join(' and ')}`,
      fix: 'Fix or delete the malformed file(s), then run: preflight install',
    };
  }

  // Determine which event types are missing the official NR collector hook.
  const missingNrEvents = (
    [!hooksPre && 'PreToolUse', !hooksPost && 'PostToolUse'] as (string | false)[]
  ).filter((x): x is string => x !== false);

  const customEvents = missingNrEvents.filter((ev) =>
    ev === 'PreToolUse' ? hooksPreAny : hooksPostAny,
  );
  const trulyMissingEvents = missingNrEvents.filter((ev) =>
    ev === 'PreToolUse' ? !hooksPreAny : !hooksPostAny,
  );

  const searched = settingsPaths.filter(existsSync).join(' or ');
  const malformedNote =
    parseErrorPaths.length > 0 ? `; ${parseErrorPaths.join(' and ')} could not be parsed` : '';

  // All missing NR hooks have some other hook command — likely a custom wrapper.
  if (trulyMissingEvents.length === 0) {
    return {
      check: 'Hooks wired',
      status: 'warn',
      detail: `${customEvents.join(' and ')} ${customEvents.length > 1 ? 'have' : 'has'} a custom hook command in ${searched} — verify it calls preflight-collector${malformedNote}`,
      fix: 'Run preflight install to use the official hook, or confirm your script calls preflight-collector <event>-tool',
    };
  }

  // At least one event type has no hook command at all — this is a real misconfiguration.
  const customNote =
    customEvents.length > 0
      ? `; ${customEvents.join(' and ')} ${customEvents.length > 1 ? 'have' : 'has'} a custom hook (verify it calls preflight-collector)`
      : '';
  return {
    check: 'Hooks wired',
    status: 'fail',
    detail: `${trulyMissingEvents.join(' and ')} not found in ${searched}${customNote}${malformedNote}`,
    fix: 'preflight install',
  };
}

function checkStorageWritable(storagePath: string): DiagnosticCheck {
  try {
    accessSync(storagePath, constants.W_OK);
    return { check: 'Storage writable', status: 'ok', detail: `${storagePath} is writable` };
  } catch {
    if (!existsSync(storagePath)) {
      return {
        check: 'Storage writable',
        status: 'fail',
        detail: `Directory not found: ${storagePath}`,
        fix: `mkdir -p ${storagePath} && chmod 700 ${storagePath}`,
      };
    }
    return {
      check: 'Storage writable',
      status: 'fail',
      detail: `Directory exists but is not writable: ${storagePath}`,
      fix: `chmod 700 ${storagePath}`,
    };
  }
}

async function checkNrReachable(skipReason: string | null): Promise<DiagnosticCheck> {
  if (skipReason !== null) {
    return { check: 'NR reachable', status: 'skip', detail: skipReason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://insights-collector.newrelic.com', {
      method: 'HEAD',
      signal: controller.signal,
    });
    // 401/403 indicate the endpoint is reachable but rejected the credentials.
    // Other 4xx (404, 405, etc.) just mean the HEAD / path has no handler —
    // the endpoint is reachable and a 404 here is unrelated to the licenseKey.
    if (response.status === 401 || response.status === 403) {
      return {
        check: 'NR reachable',
        status: 'warn',
        detail: `insights-collector.newrelic.com replied with HTTP ${response.status} — endpoint is reachable but rejected the request`,
        fix: 'Verify that licenseKey is correct and has Ingest permissions.',
      };
    }
    return {
      check: 'NR reachable',
      status: 'ok',
      detail: 'insights-collector.newrelic.com reachable',
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      check: 'NR reachable',
      status: 'fail',
      detail: isTimeout
        ? 'Request timed out after 5 s — endpoint may be reachable but slow'
        : 'Could not reach insights-collector.newrelic.com',
      fix: isTimeout
        ? 'Check for a slow proxy or firewall blocking HTTPS.'
        : 'Check network connectivity and that licenseKey is valid.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDiagnostics(opts?: {
  configPath?: string;
  storagePath?: string;
}): Promise<DiagnosticCheck[]> {
  const configPath = opts?.configPath ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const { check: configCheck, context } = checkConfigValid(configPath, opts?.storagePath);

  const settingsPaths: string[] = [detectSettingsPath('user')];
  if (isWsl()) {
    const winHome = resolveWindowsHome();
    if (winHome) settingsPaths.push(detectSettingsPath('user', winHome));
  }

  return [
    configCheck,
    ...checkDaemon(),
    checkHooksWired(settingsPaths),
    checkStorageWritable(context.storagePath),
    await checkNrReachable(context.nrSkipReason),
  ];
}
