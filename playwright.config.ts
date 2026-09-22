import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const PORT = 7790;
const ISOLATED_STORAGE = join(tmpdir(), `nr-ai-e2e-${process.pid}`);
// Both point at files that will not exist. loadConfigFile() returns {} for a path it
// cannot read and dotenv ignores a missing file, so the run gets defaults on every
// layer instead of the developer's real credentials.
const ISOLATED_CONFIG = join(ISOLATED_STORAGE, 'config.json');
const ISOLATED_DOTENV = join(ISOLATED_STORAGE, '.env');

export default defineConfig({
  testDir: './e2e',
  // {platform} keeps a macOS baseline from being compared against Linux font rasterization,
  // which maxDiffPixelRatio cannot absorb on a full-page shot. Without it, one contributor
  // re-recording overwrites every other platform's baseline.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}-{platform}{ext}',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node dist/index.js --local --config ${ISOLATED_CONFIG}`,
    port: PORT,
    // Playwright merges this over process.env, so every layer the server consults has to be
    // pinned here. --config only displaces the config file, which is the *lowest* of the
    // credential layers: .env.example documents the order as CLI > env (.env or shell) >
    // config file > defaults, src/index.ts imports 'dotenv/config' so the server reads the
    // repo-root .env itself, and src/config.ts lets NR_AI_MODE and NEW_RELIC_LICENSE_KEY beat
    // the file. Unpinned, a contributor with cloud credentials in .env or their shell either
    // ships this run's telemetry to their production account, or — with a key and no mode —
    // hits the licenseKey-without-mode error, which --local does not rescue, and every test
    // fails on a webServer timeout.
    env: {
      NR_AI_DASHBOARD_PORT: String(PORT),
      NEW_RELIC_AI_MCP_STORAGE_PATH: ISOLATED_STORAGE,
      DOTENV_CONFIG_PATH: ISOLATED_DOTENV,
      NR_AI_MODE: 'local',
      NEW_RELIC_LICENSE_KEY: '',
      NEW_RELIC_ACCOUNT_ID: '',
    },
    reuseExistingServer: !process.env.CI,
  },
});
