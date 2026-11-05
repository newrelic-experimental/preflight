import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
// globalSetup loads without moduleNameMapper, so './x.js' would not resolve.
import { INHERITED_SETTINGS_PATTERN, KEPT_CREDENTIALS } from './inherited-settings';

export const ISOLATED_HOME_ENV = 'PREFLIGHT_TEST_ISOLATED_HOME';

const HOME_PREFIX = 'preflight-jest-home-';
const STALE_HOME_MS = 6 * 60 * 60 * 1000;
const MAX_STALE_REMOVALS = 50;

type Env = Record<string, string | undefined>;
type Saved = Record<string, string | undefined>;

declare global {
  var __preflightSavedEnv: Saved | undefined;
}

export function isolateEnv(env: Env, home: string): Saved {
  const saved: Saved = {};
  const remember = (key: string): void => {
    if (!(key in saved)) saved[key] = env[key];
  };
  for (const key of Object.keys(env)) {
    if (INHERITED_SETTINGS_PATTERN.test(key) && !KEPT_CREDENTIALS.has(key)) {
      remember(key);
      delete env[key];
    }
  }
  const homeDrive = parse(home).root.replace(/[\\/]+$/, '');
  const overrides: Env = {
    [ISOLATED_HOME_ENV]: home,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: home.slice(homeDrive.length),
    // src/index.ts imports 'dotenv/config'; a missing file keeps a repo-root .env from
    // refilling the variables scrubbed above, as playwright.config.ts does.
    DOTENV_CONFIG_PATH: join(home, '.env'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    NEW_RELIC_AI_COPILOT_DIR: join(home, '.copilot'),
  };
  for (const [key, value] of Object.entries(overrides)) {
    remember(key);
    env[key] = value;
  }
  return saved;
}

export function restoreEnv(env: Env, saved: Saved): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

export function removeStaleHomes(root: string, now: number = Date.now()): void {
  try {
    let removed = 0;
    for (const name of readdirSync(root)) {
      if (removed >= MAX_STALE_REMOVALS) break;
      if (!name.startsWith(HOME_PREFIX)) continue;
      try {
        const dir = join(root, name);
        if (now - statSync(dir).mtimeMs < STALE_HOME_MS) continue;
        rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
        removed += 1;
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

export default function globalSetup(): void {
  removeStaleHomes(tmpdir());
  const home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
  globalThis.__preflightSavedEnv = isolateEnv(process.env, home);
}
