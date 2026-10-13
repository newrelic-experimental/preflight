#!/usr/bin/env tsx
/**
 * Test-runner ownership checker.
 *
 * Jest owns `*.test.ts` outside src/web, Vitest owns `src/web/**`, and
 * nothing verifies the two globs together cover every test file. This asks
 * each runner for the list it resolves (rather than re-implementing the
 * globs, so the check cannot drift from the configs) and fails when a
 * `*.test.ts` / `*.test.tsx` under src/ or test/ is claimed by zero runners
 * or by more than one.
 *
 * Deliberate exclusions live in ALLOWLIST so that opting a file out is a
 * visible decision rather than a side effect of an ignore pattern.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const TEST_FILE_RE = /\.test\.tsx?$/;

const ALLOWLIST: Readonly<Record<string, string>> = {
  'src/shared/index.test.ts':
    'verifies VERSION against the upstream package.json, which does not exist in this layout (jest.config.ts testPathIgnorePatterns)',
  'src/multi-instance.integration.test.ts':
    'spawns real child processes against a built binary; run only by `npm run test:integration`',
};

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (TEST_FILE_RE.test(entry.name)) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

function run(args: string[]): string {
  return execFileSync('npx', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function toRelativePaths(output: string): Set<string> {
  const files = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => TEST_FILE_RE.test(line))
    .map((line) => relative(ROOT, resolve(ROOT, line)).split('\\').join('/'));
  return new Set(files);
}

const INTEGRATION_TEST = 'src/multi-instance.integration.test.ts';

/**
 * The integration test is claimed by no config glob; `npm run test:integration`
 * claims it from the command line. Resolve that script's own jest arguments to
 * confirm it still selects the file, since a stale flag or an ignore pattern
 * that excludes it makes the script run zero tests.
 */
function checkIntegrationScript(problems: string[]): void {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.['test:integration'];
  if (!script?.startsWith('jest ')) {
    problems.push(`package.json "test:integration" must be a jest command, found: ${script}`);
    return;
  }
  try {
    const args = script.slice('jest '.length).match(/(?:[^\s']+|'[^']*')+/g) ?? [];
    const listed = toRelativePaths(
      run(['jest', ...args.map((arg) => arg.replaceAll("'", '')), '--listTests']),
    );
    if (!listed.has(INTEGRATION_TEST)) {
      problems.push(
        `"test:integration" does not select ${INTEGRATION_TEST}, so it runs zero tests`,
      );
    }
  } catch {
    problems.push(
      '"test:integration" failed to resolve its test list (jest rejected its arguments)',
    );
  }
}

function main(): void {
  const onDisk = [
    ...collectTestFiles(resolve(ROOT, 'src')),
    ...collectTestFiles(resolve(ROOT, 'test')),
  ].sort();
  const jest = toRelativePaths(run(['jest', '--listTests']));
  const vitest = toRelativePaths(run(['vitest', 'list', '--filesOnly']));

  const problems: string[] = [];
  for (const file of onDisk) {
    const owners = [jest.has(file) && 'jest', vitest.has(file) && 'vitest'].filter(Boolean);
    const reason = ALLOWLIST[file];
    if (reason !== undefined) {
      if (owners.length > 0) {
        problems.push(
          `${file} is allowlisted as unclaimed but ${owners.join(' and ')} claims it; drop it from ALLOWLIST in scripts/check-test-ownership.ts`,
        );
      }
    } else if (owners.length === 0) {
      problems.push(
        `${file} is claimed by no test runner, so CI never runs it. Move it under a path Jest or Vitest matches, or allowlist it with a reason in scripts/check-test-ownership.ts`,
      );
    } else if (owners.length > 1) {
      problems.push(`${file} is claimed by both jest and vitest; exactly one runner may own it`);
    }
  }
  for (const file of Object.keys(ALLOWLIST)) {
    if (!onDisk.includes(file)) {
      problems.push(
        `ALLOWLIST entry ${file} no longer exists; remove it from scripts/check-test-ownership.ts`,
      );
    }
  }

  checkIntegrationScript(problems);

  if (problems.length > 0) {
    console.error('Test ownership check failed:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(
    `✓ ${onDisk.length} test files: ${jest.size} jest, ${vitest.size} vitest, ${Object.keys(ALLOWLIST).length} allowlisted`,
  );
}

main();
