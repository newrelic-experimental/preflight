import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ISOLATED_HOME_ENV = 'PREFLIGHT_TEST_ISOLATED_HOME';

export default function globalSetup(): void {
  const home = mkdtempSync(join(tmpdir(), 'preflight-jest-home-'));
  process.env[ISOLATED_HOME_ENV] = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}
