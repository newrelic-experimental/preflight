import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ISOLATED_HOME_ENV = 'PREFLIGHT_TEST_ISOLATED_HOME';

/** Same pattern playwright.config.ts uses to seal e2e runs off from the developer's shell. */
const INHERITED_SETTINGS = /^(NEW_RELIC_|NR_AI_|OTEL_|CLAUDE|MCP_CLIENT)/;

type Env = Record<string, string | undefined>;
type Saved = Record<string, string | undefined>;

declare global {
  var __preflightSavedEnv: Saved | undefined;
}

export function isolateEnv(env: Env, home: string, platform: string = process.platform): Saved {
  const saved: Saved = {};
  const remember = (key: string): void => {
    if (!(key in saved)) saved[key] = env[key];
  };
  for (const key of Object.keys(env)) {
    if (INHERITED_SETTINGS.test(key)) {
      remember(key);
      delete env[key];
    }
  }
  const overrides: Env = {
    [ISOLATED_HOME_ENV]: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    NEW_RELIC_AI_COPILOT_DIR: join(home, '.copilot'),
  };
  if (platform === 'win32') overrides.USERPROFILE = home;
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

export default function globalSetup(): void {
  const home = mkdtempSync(join(tmpdir(), 'preflight-jest-home-'));
  globalThis.__preflightSavedEnv = isolateEnv(process.env, home);
}
