import { rmSync } from 'node:fs';

export default function globalTeardown(): void {
  const home = process.env.PREFLIGHT_TEST_ISOLATED_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
}
