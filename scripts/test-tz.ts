#!/usr/bin/env tsx
/**
 * Runs the zone-sensitive tests listed in test/support/tz-sensitive-tests.json
 * under the zone in the TZ environment variable, and nothing else. CI uses this
 * for the non-default zones, where re-running every test would only repeat
 * tests that never read the host's zone. Run it with a zone, for example
 * `TZ=Pacific/Auckland npm run test:tz`.
 *
 * scripts/check-tz-tests.ts keeps the list in step with the test files.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface TzTestList {
  readonly jest: readonly string[];
  readonly vitest: readonly string[];
}

const list = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/support/tz-sensitive-tests.json'), 'utf8'),
) as TzTestList;

function run(args: readonly string[]): number {
  const result = spawnSync('npx', [...args], { stdio: 'inherit', cwd: process.cwd() });
  if (result.status === null) {
    console.error(
      `npx ${args[0]} did not exit normally: ${result.error?.message ?? `killed by ${result.signal}`}`,
    );
    return 1;
  }
  return result.status;
}

// With no file arguments, jest and vitest run everything.
if (list.jest.length === 0 || list.vitest.length === 0) {
  console.error('test/support/tz-sensitive-tests.json needs at least one jest and one vitest file');
  process.exit(1);
}

// Node falls back to UTC for a TZ it does not recognise, so a misspelled zone would run
// the tests under UTC and pass.
if (process.env.TZ !== undefined) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: process.env.TZ });
  } catch {
    console.error(`TZ=${process.env.TZ} is not a time zone this Node recognises`);
    process.exit(1);
  }
}

console.log(`Zone-sensitive tests under TZ=${process.env.TZ ?? '(host default)'}`);
// --runTestsByPath takes the paths literally. By default jest reads each as an unanchored regex.
const jestStatus = run(['jest', '--runTestsByPath', ...list.jest]);
const vitestStatus = run(['vitest', 'run', ...list.vitest]);
process.exit(jestStatus !== 0 || vitestStatus !== 0 ? 1 : 0);
