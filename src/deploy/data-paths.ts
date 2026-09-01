import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Resolve the directory containing bundled data files (alerts/, dashboards/,
 * or pricing-overlay/ JSON definitions).
 *
 * The deploy modules ship as `dist/deploy/*.js` after TypeScript build, with
 * data files copied into `dist/data/<name>/` by the postbuild step (see
 * `package.json:build:server`). When running from a global npm install, the
 * tarball contains everything under `dist/`, so the data lives at
 * `<dist>/data/<name>/`.
 *
 * For local dev (running tests from `src/deploy/*.test.ts`), the JSON files
 * live at the repo root in `<repoRoot>/<name>/`. We probe both locations so
 * the same code works in both layouts.
 *
 * Uses `process.argv[1]` rather than `import.meta.url` to avoid tripping
 * Jest's TS-module check — same pattern as `src/install/setup-wizard.ts`.
 *
 * Throws if no candidate exists — the deploy commands cannot run without the
 * underlying data files. Callers for whom the data is optional (e.g. the
 * pricing overlay, unlike alerts/dashboards which are required for their own
 * commands) must wrap this in a try/catch and degrade gracefully.
 */
export function resolveDataDir(name: 'alerts' | 'dashboards' | 'pricing-overlay'): string {
  const rawPath = process.argv[1] ?? process.cwd();
  const scriptPath = (() => {
    try {
      return realpathSync(rawPath);
    } catch {
      return rawPath;
    }
  })();
  const scriptDir = dirname(scriptPath);

  // Post-build (npm install -g): `dist/index.js` → `dist/data/<name>/`
  const bundledFromIndex = resolve(scriptDir, 'data', name);
  if (existsSync(bundledFromIndex)) return bundledFromIndex;

  // Source/dev (`node dist/index.js` invoked from repo): repo root → `<root>/<name>/`
  const sourceTreeFromIndex = resolve(scriptDir, '..', name);
  if (existsSync(sourceTreeFromIndex)) return sourceTreeFromIndex;

  // Direct module invocation (`node dist/deploy/deploy-dashboards.js`): one level deeper
  const bundledFromDeploy = resolve(scriptDir, '..', 'data', name);
  if (existsSync(bundledFromDeploy)) return bundledFromDeploy;

  // Test layout (`src/deploy/*.test.ts` via jest): walk up to repo root
  const sourceTreeFromDeploy = resolve(scriptDir, '..', '..', name);
  if (existsSync(sourceTreeFromDeploy)) return sourceTreeFromDeploy;

  // Final fallback — jest's `process.argv[1]` points into node_modules/jest,
  // so `scriptDir`-based probes can miss the repo. Try `process.cwd()` last.
  const fromCwd = resolve(process.cwd(), name);
  if (existsSync(fromCwd)) return fromCwd;
  // And the bundled location relative to cwd, in case cwd is inside dist/.
  const bundledFromCwd = resolve(process.cwd(), 'dist', 'data', name);
  if (existsSync(bundledFromCwd)) return bundledFromCwd;

  throw new Error(
    `Could not locate ${name}/ data directory. Tried:\n` +
      `  - ${bundledFromIndex}\n` +
      `  - ${sourceTreeFromIndex}\n` +
      `  - ${bundledFromDeploy}\n` +
      `  - ${sourceTreeFromDeploy}\n` +
      `  - ${fromCwd}\n` +
      `  - ${bundledFromCwd}\n` +
      `If you installed this package via npm, the data files should be bundled in dist/data/. ` +
      `Run \`npm run build\` first if you're working from source.`,
  );
}
