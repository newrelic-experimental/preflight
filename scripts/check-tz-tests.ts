#!/usr/bin/env tsx
/**
 * Zone-sensitive test list checker.
 *
 * CI runs the full suites under one zone and only the tests in
 * test/support/tz-sensitive-tests.json under the others (`npm run test:tz`).
 * A test that reads the host's zone but is missing from the list would then
 * run under one zone only, and a zone-dependent bug in it would pass CI.
 *
 * This fails when a test file uses a local-time API directly and is not on the
 * list, when the list names a file that no longer exists, when a file is on
 * the wrong runner's list, or when a file appears twice. It cannot see a test
 * that reaches local time only through source code (the helpers in
 * src/lib/date.ts, for example). When a test fails under one zone and passes
 * under another, add it to the list by hand.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const LIST_PATH = 'test/support/tz-sensitive-tests.json';
const TEST_FILE_RE = /\.test\.tsx?$/;

// Calls whose result depends on the host's zone: the local getters and setters,
// `new Date(y, m, ...)` with literals or variables, a date-time string with no
// offset (parsed as local time), and Intl formatting without a pinned zone.
const LOCAL_TIME_RE = new RegExp(
  [
    'get(?:Hours|Minutes|Seconds|Milliseconds|Date|Day|Month|FullYear)\\(',
    'set(?:Hours|Minutes|Seconds|Milliseconds|Date|Month|FullYear)\\(',
    'getTimezoneOffset',
    'toLocale',
    'toTimeString',
    'toDateString',
    'new Date\\([^()]*,',
    '(?:new Date|Date\\.parse)\\([\'"`]\\d{4}-\\d{2}-\\d{2}[T ][\\d:.]+[\'"`]\\)',
    'resolvedOptions',
    'timeZone',
    'process\\.env\\.TZ',
    'startOfDay',
    'startOfWeek',
    'Intl\\.DateTimeFormat',
  ].join('|'),
);

// The local-day helpers in src/lib/date.ts. docs/TEST_PATTERNS.md tells tests to build
// fixtures with them, so a test that calls one reads the host's zone. Read from the
// source so a new helper is covered without editing this file.
function localDayHelperRe(): RegExp {
  const source = readFileSync(resolve(ROOT, 'src/lib/date.ts'), 'utf8');
  const names = [
    ...source.matchAll(/^export (?:async )?function (\w+)/gm),
    ...source.matchAll(
      /^export const (\w+)\s*(?::(?:[^=]|=>)+?)?=(?!>)\s*(?:async\s*)?(?:\(|function\b)/gm,
    ),
  ].map((m) => m[1]);
  // An empty name list would build a pattern that matches every file.
  if (names.length === 0) {
    throw new Error(
      'found no exported functions in src/lib/date.ts; update localDayHelperRe in scripts/check-tz-tests.ts for its new export style',
    );
  }
  return new RegExp(`\\b(?:${names.join('|')})\\b`);
}

interface TzTestList {
  readonly jest: readonly string[];
  readonly vitest: readonly string[];
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (TEST_FILE_RE.test(entry.name)) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

function main(): void {
  const list = JSON.parse(readFileSync(resolve(ROOT, LIST_PATH), 'utf8')) as TzTestList;
  const onDisk = new Set([
    ...collectTestFiles(resolve(ROOT, 'src')),
    ...collectTestFiles(resolve(ROOT, 'test')),
  ]);
  const problems: string[] = [];

  const listed = new Set<string>();
  const entries: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['jest', list.jest],
    ['vitest', list.vitest],
  ];
  for (const [runner, files] of entries) {
    for (const file of files) {
      const isWeb = file.startsWith('src/web/');
      if (!onDisk.has(file)) {
        problems.push(`${LIST_PATH} names ${file}, which no longer exists; remove it`);
      } else if (
        runner === 'vitest' &&
        [...onDisk].filter((other) => other.includes(file)).length > 1
      ) {
        // Vitest reads each listed path as a substring filter, so a longer path that
        // contains this one would run too.
        problems.push(`${file} is a substring of another test path, so vitest would run both`);
      } else if (isWeb !== (runner === 'vitest')) {
        problems.push(
          `${file} is under "${runner}" in ${LIST_PATH}; src/web tests belong under "vitest", the rest under "jest"`,
        );
      }
      if (listed.has(file)) problems.push(`${file} appears more than once in ${LIST_PATH}`);
      listed.add(file);
    }
  }

  const helperRe = localDayHelperRe();
  for (const file of [...onDisk].sort()) {
    if (listed.has(file)) continue;
    // A comment that names an API or helper does not call it. Only comments that start
    // their line are dropped: a `/*` or ` //` inside a string would otherwise swallow real
    // code, and a trailing comment that over-flags costs one listed test, not a missed one.
    const code = readFileSync(resolve(ROOT, file), 'utf8')
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    if (LOCAL_TIME_RE.test(code) || helperRe.test(code)) {
      problems.push(
        `${file} uses a local-time API but is not in ${LIST_PATH}, so CI runs it under one zone only. Add it to the "${file.startsWith('src/web/') ? 'vitest' : 'jest'}" list, or make the test independent of the host zone`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('Zone-sensitive test list check failed:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(
    `✓ ${listed.size} zone-sensitive tests listed (${list.jest.length} jest, ${list.vitest.length} vitest)`,
  );
}

main();
