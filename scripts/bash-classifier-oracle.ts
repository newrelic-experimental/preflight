// Checks classifyBash against real bash. Generates seeded commands from safe
// pieces (echo, true, x=, cat, quotes, escapes, comments, heredocs) that end in
// `rm -rf /tmp/x`, runs each under bash with `rm` shadowed by a function and PATH
// holding only `cat`, and compares whether bash reached the marker with
// isDestructive. Writes an evenly spaced slice for bash-classifier.test.ts.
//
//   tsx scripts/bash-classifier-oracle.ts --seed 1177 --count 3000 \
//     --fixture src/hooks/bash-classifier.oracle.json [--rows all.json] [--compare other-classifier.ts]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { format, resolveConfig } from 'prettier';

import { classifyBash } from '../src/hooks/bash-classifier.js';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1177' },
    count: { type: 'string', default: '3000' },
    slice: { type: 'string', default: '200' },
    fixture: { type: 'string' },
    rows: { type: 'string' },
    compare: { type: 'string', multiple: true, default: [] },
    bash: { type: 'string', default: '/bin/bash' },
  },
});

const MARKER = 'rm -rf /tmp/x';
const RAN = '__marker_ran__';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(Number(values.seed));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
const repeat = (lo: number, hi: number, make: () => string, sep = ''): string =>
  Array.from({ length: lo + Math.floor(random() * (hi - lo + 1)) }, make).join(sep);

const INNER = [
  'a',
  ' ',
  '#',
  ';',
  "'",
  '"',
  '\\',
  "\\'",
  '\\"',
  '\\\\',
  '$',
  '{',
  '}',
  '(',
  ')',
  '\n',
  '&',
  '|',
];
const inner = (): string => repeat(0, 4, () => pick(INNER));
const oneLine = (): string => inner().replaceAll('\n', '');

const FRAGMENTS: readonly (() => string)[] = [
  () => pick(['a', 'it', 'b2', 's']),
  () => `'${inner().replaceAll("'", '')}'`,
  () => `"${inner()}"`,
  () => `$'${inner()}'`,
  () => pick(["\\'", '\\"', '\\#', '\\$', '\\\\', '\\ ', '\\;', '\\&', '\\|']),
  () => '#',
  () =>
    pick([
      '${x}',
      '${#x}',
      '${x#a}',
      '$x',
      '$#',
      '$(echo a)',
      "$(echo 'a')",
      '"$(echo "a")"',
      '`echo a`',
      "$'\\''",
    ]),
  () => pick(["'", '"', "$'"]),
];
const word = (): string => repeat(1, 3, () => pick(FRAGMENTS)());

interface Statement {
  readonly text: string;
  readonly needsNewline: boolean;
}
const STATEMENTS: readonly (() => Statement)[] = [
  () => ({ text: `echo ${repeat(1, 3, word, ' ')}`, needsNewline: false }),
  () => ({ text: `true ${repeat(0, 2, word, ' ')}`, needsNewline: false }),
  () => ({ text: `x=${word()}`, needsNewline: false }),
  () => ({ text: `cat <<<${word()}`, needsNewline: false }),
  () => ({
    text: `cat <<${pick(['EOF', "'EOF'", '-EOF'])}\n${repeat(0, 2, inner, '\n')}\nEOF`,
    needsNewline: true,
  }),
  () => ({ text: `# ${oneLine()}`, needsNewline: true }),
  () => ({ text: `(echo ${word()})${pick(['', '#', ' #'])}${word()}`, needsNewline: false }),
];
// `||` is left out: after a command that succeeds, bash skips the marker for a
// reason no lexer can see.
const SEPARATORS = ['; ', ';', ' && ', ' | ', ' & ', '\n'];

function statement(): Statement {
  const s = pick(STATEMENTS)();
  if (!s.needsNewline && random() < 0.15)
    return { text: `${s.text} #${oneLine()}`, needsNewline: true };
  return s;
}

function command(): string {
  let out = '';
  for (let k = 1 + Math.floor(random() * 3); k > 0; k--) {
    const s = statement();
    out += s.text + (s.needsNewline ? '\n' : pick(SEPARATORS));
  }
  return out + MARKER;
}

interface Row {
  readonly cmd: string;
  readonly ran: boolean;
  readonly rejected: boolean;
  readonly got: readonly boolean[];
}

const sandbox = mkdtempSync(join(tmpdir(), 'bash-oracle-'));
const bin = join(sandbox, 'bin');
mkdirSync(bin);
symlinkSync('/bin/cat', join(bin, 'cat'));

function runBash(cmd: string): { ran: boolean; rejected: boolean } | undefined {
  const res = spawnSync(
    values.bash,
    ['--norc', '--noprofile', '-c', `rm() { echo ${RAN}; }\n${cmd}`],
    {
      cwd: sandbox,
      env: { PATH: bin, HOME: sandbox },
      input: '',
      timeout: 2000,
      encoding: 'utf8',
    },
  );
  if (res.error || res.signal) return undefined;
  return {
    ran: res.stdout.includes(RAN),
    rejected: /syntax error|unexpected EOF|bad substitution|command not found/.test(res.stderr),
  };
}

type Classify = (command: string) => { readonly isDestructive: boolean };
const classifiers: Classify[] = [classifyBash];
for (const path of values.compare) {
  classifiers.push(((await import(resolve(path))) as { classifyBash: Classify }).classifyBash);
}

const rows: Row[] = [];
let timeouts = 0;
for (let k = Number(values.count); k > 0; k--) {
  const cmd = command();
  const result = runBash(cmd);
  if (result === undefined) timeouts++;
  else rows.push({ cmd, ...result, got: classifiers.map((c) => c(cmd).isDestructive) });
}
rmSync(sandbox, { recursive: true, force: true });

const missed = rows.filter((r) => r.ran && !r.got[0]).length;
const overFlagged = rows.filter((r) => !r.ran && r.got[0]).length;
console.log(
  JSON.stringify({
    seed: values.seed,
    kept: rows.length,
    timeouts,
    ran: rows.filter((r) => r.ran).length,
    missed,
    overFlagged,
  }),
);
if (values.rows) writeFileSync(values.rows, JSON.stringify(rows));
if (values.fixture) {
  const step = Math.floor(rows.length / Number(values.slice));
  const slice = rows.filter((_, k) => k % step === 0).slice(0, Number(values.slice));
  const config = await resolveConfig(values.fixture);
  const json = JSON.stringify(slice.map((r) => [r.cmd, r.ran]));
  writeFileSync(values.fixture, await format(json, { ...config, filepath: values.fixture }));
}
