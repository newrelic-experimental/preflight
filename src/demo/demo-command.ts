import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

import { DEFAULT_STORAGE_PATH } from '../config.js';
import { AlertLog } from '../alerts/alert-log.js';
import { readParentAndCommand } from '../hooks/process-ancestry.js';
import { LocalStore } from '../storage/local-store.js';
import { SessionStore } from '../storage/session-store.js';
import { getIsoWeekId, WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import { waitForHealthyDashboard } from '../install/dashboard-health.js';
import { buildDemoData, DEMO_DEVELOPER } from './demo-data.js';

export const DEFAULT_DEMO_DIR = resolve(homedir(), '.newrelic-preflight-demo');
// Clear of 7777 (installed dashboard), 7788 (manual previews), 7790/7791 (e2e, pf-verify).
export const DEFAULT_DEMO_PORT = 7799;
const DEMO_HOST = '127.0.0.1';
// Present only in directories this command created, so --dir can never wipe real data.
const DEMO_MARKER = '.preflight-demo';

export interface DemoOptions {
  readonly dir: string;
  readonly port: number;
  readonly open: boolean;
}

function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/**
 * Replace `dir` with a freshly seeded demo storage root and a local-only
 * config. Re-running converges to the same state, so a rehearsal and the
 * live demo show identical data (dated relative to `now`).
 */
export async function seedDemoDir(
  dir: string,
  now: Date = new Date(),
): Promise<{ configPath: string; sessionCount: number }> {
  const target = realpathIfExists(resolve(dir));
  const real = realpathIfExists(
    resolve(process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_PATH),
  );
  if (target === real || target.startsWith(real + sep) || real.startsWith(target + sep)) {
    throw new Error(
      `Refusing to seed demo data in or around the real Preflight storage dir (${real}).`,
    );
  }
  if (existsSync(target)) {
    if (!existsSync(resolve(target, DEMO_MARKER))) {
      throw new Error(
        `${target} exists and was not created by \`preflight demo\`; pick another --dir.`,
      );
    }
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(target, DEMO_MARKER), '', { mode: 0o600 });

  const { sessions, auditEntries, alerts } = buildDemoData(now);
  const configPath = resolve(target, 'config.json');
  const config = {
    mode: 'local',
    storagePath: target,
    developer: DEMO_DEVELOPER,
    alerts: { osNotifications: false },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const localStore = new LocalStore(target);
  localStore.initialize();
  const sessionStore = new SessionStore({ storagePath: target });
  for (const session of sessions) sessionStore.saveSession(session);
  for (const entry of auditEntries) localStore.appendAuditLog(entry);
  const alertLog = new AlertLog({ path: resolve(target, 'alerts', 'log.jsonl') });
  for (const alert of alerts) await alertLog.append(alert);
  const weekly = new WeeklySummaryGenerator({ storagePath: target, sessionStore });
  const weekIds = new Set(sessions.map((s) => getIsoWeekId(new Date(s.startTime))));
  for (const weekId of weekIds) weekly.generate(weekId);
  return { configPath, sessionCount: sessions.length };
}

/**
 * The demo server's whole environment. `HOME` is sandboxed because the
 * transcript and usage watchers read `~/.claude/projects` and `~/.copilot`
 * unconditionally, which would pull the presenter's real sessions into the
 * demo. Inherited Preflight and Claude Code variables are dropped so a shell
 * profile or a calling agent's session can't override the demo settings.
 */
export function demoEnv(dir: string, port: number, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^(CLAUDE|NEW_RELIC_|NR_AI_)/.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: demoHome(dir),
    USERPROFILE: demoHome(dir),
    DOTENV_CONFIG_PATH: resolve(dir, '.env'),
    NR_AI_MODE: 'local',
    NEW_RELIC_AI_MCP_STORAGE_PATH: resolve(dir),
    NR_AI_DASHBOARD_PORT: String(port),
    // Detected as Claude Code, the platform the seeded sessions mostly came from.
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  };
}

const demoHome = (dir: string) => resolve(dir, 'home');

/**
 * Demo servers a previous run left behind (its terminal closed or the parent
 * was killed), so re-running `preflight demo` can stop them and recover. Found
 * through the instance registry every `--local` process writes to its storage
 * dir, then confirmed by the live command line still naming this dir's config,
 * so a recycled pid is never mistaken for one.
 */
export function staleDemoServerPids(dir: string): number[] {
  const configPath = resolve(dir, 'config.json');
  if (!existsSync(resolve(dir, DEMO_MARKER))) return [];
  return new LocalStore(resolve(dir))
    .listLocalInstances()
    .filter((i) => i.alive && readParentAndCommand(i.pid)?.command.includes(configPath))
    .map((i) => i.pid);
}

export async function runDemo(options: DemoOptions): Promise<number> {
  const dir = resolve(options.dir);
  const url = `http://${DEMO_HOST}:${options.port}`;
  if (await waitForHealthyDashboard(DEMO_HOST, options.port, null, 0)) {
    process.stderr.write(
      `A Preflight dashboard is already running at ${url}. Stop it or pass --port.\n`,
    );
    return 1;
  }
  const { configPath, sessionCount } = await seedDemoDir(dir);
  mkdirSync(demoHome(dir), { recursive: true, mode: 0o700 });
  const logPath = resolve(dir, 'server.log');
  const log = openSync(logPath, 'a', 0o600);
  const entry = realpathSync(process.argv[1] ?? '');
  const args = [entry, '--local', '--config', configPath, '--log-level', 'warn'];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    stdio: ['ignore', 'ignore', log],
    env: demoEnv(dir, options.port, process.env),
  });
  const exited = new Promise<number>((done) => child.once('exit', (code) => done(code ?? 1)));
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  const started = await Promise.race([
    waitForHealthyDashboard(DEMO_HOST, options.port, null, 30_000),
    exited.then(() => false),
  ]);
  if (!started) {
    child.kill('SIGTERM');
    process.stderr.write(`The Preflight demo failed to start. Details are in ${logPath}\n`);
    return 1;
  }
  process.stdout.write(
    `\n✓ Preflight demo running at ${url}\n` +
      `  ${sessionCount} seeded sessions in ${dir} (your real data is untouched)\n` +
      '  Press Ctrl+C to stop.\n\n',
  );
  if (options.open && process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
  return exited;
}
