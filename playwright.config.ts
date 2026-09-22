import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const PORT = 7790;
const ISOLATED_STORAGE = join(tmpdir(), `nr-ai-e2e-${process.pid}`);
// Deliberately absent: loadConfigFile() returns {} for a path it cannot read, so this
// gives the run defaults instead of the developer's real config. NEW_RELIC_AI_MCP_STORAGE_PATH
// redirects storage only; the config file path resolves from a hardcoded home directory,
// so without this the dashboard would load real cloud credentials and emit this run's
// telemetry to a production account.
const ISOLATED_CONFIG = join(ISOLATED_STORAGE, 'config.json');

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
    env: {
      NR_AI_DASHBOARD_PORT: String(PORT),
      NEW_RELIC_AI_MCP_STORAGE_PATH: ISOLATED_STORAGE,
    },
    reuseExistingServer: !process.env.CI,
  },
});
