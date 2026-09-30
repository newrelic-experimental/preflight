import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { EMPTY_PORT, EMPTY_URL, SEEDED_PORT } from './e2e/servers.js';

const RUN_ROOT = join(tmpdir(), `nr-ai-e2e-${process.pid}`);

/**
 * Every setting the server reads from the environment, as the runner inherited it, mapped to
 * undefined. Playwright spawns the server with process.env merged under `env`, and Node drops
 * undefined values from a child's environment, so spreading this first unsets them: a
 * contributor's exported license key, OTLP endpoint, budget cap or retention window never
 * reaches the run. An empty string would not do: `??` fallbacks in src/config.ts keep ''.
 */
const INHERITED_SETTINGS = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => /^(NEW_RELIC_|NR_AI_|OTEL_|CLAUDE_)/.test(key))
    .map((key) => [key, undefined]),
);

/**
 * One `--local` dashboard over its own temp directory, sealed off from the developer's
 * machine. The directory doubles as the storage path and as HOME, and --config and the
 * .env path both point into it at files that will not exist: loadConfigFile() returns {}
 * for a path it cannot read and dotenv ignores a missing file, so the run gets defaults on
 * every layer instead of the developer's real credentials and data.
 */
function isolatedServer(name: string, port: number, prelude?: (dir: string) => string) {
  const dir = join(RUN_ROOT, name);
  const serve = `node dist/index.js --local --config ${join(dir, 'config.json')}`;
  return {
    command: prelude ? `${prelude(dir)} && ${serve}` : serve,
    port,
    // Playwright merges this over process.env, so every input the server consults is
    // either unset by INHERITED_SETTINGS or pinned here — a shell export beats anything the
    // config file says. Typed as Playwright's string map, which has no slot for the
    // undefined values that do the unsetting.
    env: {
      ...INHERITED_SETTINGS,
      NR_AI_DASHBOARD_PORT: String(port),
      NR_AI_DASHBOARD_HOST: '127.0.0.1',
      NR_AI_DASHBOARD_OPEN: 'false',
      NEW_RELIC_AI_MCP_STORAGE_PATH: dir,
      NEW_RELIC_AI_MCP_BUFFER_PATH: join(dir, 'buffer.jsonl'),
      // --config only displaces the config file, the *lowest* credential layer:
      // .env.example documents the order as CLI > env (.env or shell) > config file >
      // defaults, src/index.ts imports 'dotenv/config' so the server reads the repo-root
      // .env itself, and src/config.ts lets NR_AI_MODE and NEW_RELIC_LICENSE_KEY beat the
      // file. A contributor's .env would otherwise either ship this run's telemetry to their
      // production account, or — with a key and no mode — hit the licenseKey-without-mode
      // error, which --local does not rescue, and fail every test on a webServer timeout.
      // The shell's copies are unset above; the same goes for the homelab URL and token,
      // which start the forwarder in every mode (docs/homelab.md), and CLAUDE_JOB_DIR, from
      // which a run launched inside a Claude Code session would adopt that session's id.
      DOTENV_CONFIG_PATH: join(dir, '.env'),
      NR_AI_MODE: 'local',
      // The transcript and usage watchers run in --local too, unscoped, reading
      // ~/.claude/projects, VS Code's workspaceStorage and the Copilot app's data.db under
      // os.homedir(). On a machine that used Claude Code in the last 24 hours they would
      // import real sessions and race every empty-state assertion. Pointing HOME (and its
      // Windows counterparts) at the temp dir keeps them running, against nothing.
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: join(dir, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(dir, '.config'),
      NEW_RELIC_AI_COPILOT_DIR: join(dir, '.copilot'),
      // The developer override, then the login-name fallbacks inferDeveloper() reads; any of
      // them would stamp the run's sessions with the developer's name.
      NEW_RELIC_AI_MCP_DEVELOPER: 'e2e',
      USER: 'e2e',
      USERNAME: 'e2e',
    } as Record<string, string>,
    reuseExistingServer: !process.env.CI,
  };
}

export default defineConfig({
  testDir: './e2e',
  // {platform} keeps a macOS baseline from being compared against Linux font rasterization,
  // which maxDiffPixelRatio cannot absorb on a full-page shot. Without it, one contributor
  // re-recording overwrites every other platform's baseline.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}-{platform}{ext}',
  timeout: 30_000,
  retries: 0,
  // A committed test.only would otherwise pass the e2e job on the one test it kept.
  forbidOnly: !!process.env.CI,
  // In CI, a missing baseline is a failure, not an invitation to write one: the file it
  // would write lands on a throwaway runner, and the run should say which one is absent.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: EMPTY_URL,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    isolatedServer('empty', EMPTY_PORT),
    isolatedServer('seeded', SEEDED_PORT, (dir) => `npx tsx e2e/fixtures/seed-store.ts ${dir}`),
  ],
});
