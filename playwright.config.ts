import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { EMPTY_PORT, EMPTY_URL, SEEDED_PORT } from './e2e/servers.js';

const RUN_ROOT = join(tmpdir(), `nr-ai-e2e-${process.pid}`);

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
    // Playwright merges this over process.env, so every input the server consults has to
    // be pinned here — a shell export beats anything the config file says.
    env: {
      NR_AI_DASHBOARD_PORT: String(port),
      NR_AI_DASHBOARD_HOST: '127.0.0.1',
      NR_AI_DASHBOARD_OPEN: 'false',
      NEW_RELIC_AI_MCP_STORAGE_PATH: dir,
      NEW_RELIC_AI_MCP_BUFFER_PATH: join(dir, 'buffer.jsonl'),
      // --config only displaces the config file, the *lowest* credential layer:
      // .env.example documents the order as CLI > env (.env or shell) > config file >
      // defaults, src/index.ts imports 'dotenv/config' so the server reads the repo-root
      // .env itself, and src/config.ts lets NR_AI_MODE and NEW_RELIC_LICENSE_KEY beat the
      // file. Unpinned, a contributor with cloud credentials in .env or their shell either
      // ships this run's telemetry to their production account, or — with a key and no
      // mode — hits the licenseKey-without-mode error, which --local does not rescue, and
      // every test fails on a webServer timeout.
      DOTENV_CONFIG_PATH: join(dir, '.env'),
      NR_AI_MODE: 'local',
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
      // The homelab forwarder starts on URL + token alone, in every mode — forwarding from
      // a --local install is a supported setup (docs/homelab.md) — so an exported pair
      // would ship this run's events to the developer's homelab box.
      NEW_RELIC_AI_HOMELAB_URL: '',
      NEW_RELIC_AI_HOMELAB_TOKEN: '',
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
      // Set when the run is launched from inside a Claude Code session; the server would
      // adopt that session's id from its state.json.
      CLAUDE_JOB_DIR: '',
      // inferDeveloper() falls back to these, which would stamp the run's sessions with the
      // developer's login name and make the stores differ from machine to machine.
      USER: 'e2e',
      USERNAME: 'e2e',
      NR_AI_ALERTS_RULES_PATH: '',
    },
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
