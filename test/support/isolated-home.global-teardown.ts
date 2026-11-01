import { rmSync } from 'node:fs';
import { ISOLATED_HOME_ENV, restoreEnv } from './isolated-home.global-setup';

export default function globalTeardown(): void {
  const home = process.env[ISOLATED_HOME_ENV];
  if (globalThis.__preflightSavedEnv) restoreEnv(process.env, globalThis.__preflightSavedEnv);
  if (home) rmSync(home, { recursive: true, force: true });
}
