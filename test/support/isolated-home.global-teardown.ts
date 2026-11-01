import { rmSync } from 'node:fs';
// globalTeardown loads without moduleNameMapper, so './x.js' does not resolve.
import { ISOLATED_HOME_ENV, restoreEnv } from './isolated-home.global-setup';

export default function globalTeardown(): void {
  const home = process.env[ISOLATED_HOME_ENV];
  if (globalThis.__preflightSavedEnv) restoreEnv(process.env, globalThis.__preflightSavedEnv);
  if (!home) return;
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best effort: a Windows EBUSY on a temp dir must not fail a green run.
  }
}
