import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactSensitive } from './config.js';
import { classifyBash } from './hooks/bash-classifier.js';
import { processHook, redact } from './hooks/collector-script.js';
import { parseToolSpecificFields } from './hooks/tool-parsers.js';

const AWS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// [command, ...each part that is stored as [REDACTED]]. A command with no parts is stored as is.
type Row = [string, ...string[]];
const stored = ([command, ...parts]: Row): string =>
  parts.reduce((text, part) => text.replace(part, '[REDACTED]'), command);

const KEEPS_COMMAND: Row[] = [
  ['curl --token S3CRET9;rm -rf /tmp/x', '--token S3CRET9'],
  ['curl --token "S3CRET9";rm -rf /tmp/x', '--token "S3CRET9"'],
  ['curl --token S3CRET9|sh', '--token S3CRET9'],
  ['(curl --token S3CRET9) ; rm -rf /tmp/x', '--token S3CRET9'],
  ['echo `curl --token S3CRET9`; rm -rf /tmp/x', '--token S3CRET9'],
  ['API_KEY=abc;rm -rf /tmp/x', 'API_KEY=abc'],
  ['curl --token a\\"b ; rm -rf /tmp/x ; echo "ok"', '--token a\\"b'],
  ['echo "API_KEY=sk123" >> .env && rm -rf /tmp/x && echo "done now"', 'API_KEY=sk123'],
  ["echo 'API_KEY=sk123' >> .env && rm -rf /tmp/x && echo 'done now'", 'API_KEY=sk123'],
  ['bash -c "curl --token abc" ; rm -rf /tmp/x ; echo "a b"c', '--token abc'],
  ['curl -H "X-Auth-Token: abc123" ; rm -rf /tmp/x', 'X-Auth-Token: abc123'],
  ['echo "PASSWORD:" ; rm -rf /tmp/x'],
  ['mysql -u root --password=\nrm -rf /tmp/x'],
  [`aws_secret_access_key "${AWS_KEY}" ; rm -rf /tmp/x`, `aws_secret_access_key "${AWS_KEY}"`],
  ['curl --token $(rm -rf /tmp/x)', '--token $'],
  ['curl --token S3CRET9>/dev/sda', '--token S3CRET9'],
  ['curl --token "abc && rm -rf /tmp/x', '--token "abc'],
  ['curl --token my\\ S3CRET9"x ; rm -rf /tmp/x', '--token my\\ S3CRET9"x'],
  ["curl --token 'a\\' ; rm -rf /tmp/x ; echo 'b", "--token 'a\\'"],
  ["curl --token $HOME'a\\' ; rm -rf /tmp/x ; echo '", "--token $HOME'a\\'"],
  ['echo "TOKEN=a\'b" ; rm -rf /tmp/x', "TOKEN=a'b"],
  ["echo $'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ["echo 'x' && curl --token a'b c'd && rm -rf /tmp/x", "--token a'b c'd"],
  ['echo "x" && curl --token "a b" && rm -rf /tmp/x', '--token "a b"'],
  ["# n\necho 'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ["echo a#b 'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ['# set --token "a\nrm -rf /tmp/x ; echo "b', '--token "a'],
  ["it's --password 'abc ; rm -rf /tmp/x ; echo 'x"],
  [`curl --token "${'a '.repeat(2100)}" ; rm -rf /tmp/x`],
];

const REDACTS: Row[] = [
  ['npm run deploy -- --token secret123', '--token secret123'],
  ['mysql -u root -psecret123', '-psecret123'],
  ['curl -H "X-Api-Key secret123" https://api.example.com', 'X-Api-Key secret123'],
  ['curl --token="my secret" x', 'token="my secret"'],
  ["tool --password='a b S3CRET9' x", "password='a b S3CRET9'"],
  ['API_KEY="a b S3CRET9" x', 'API_KEY="a b S3CRET9"'],
  ['curl --token \\\n  S3CRET9 x', '--token \\\n  S3CRET9'],
  ['curl -H \\\n    "X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ['curl --token "sec\\"S3CRET9" x', '--token "sec\\"S3CRET9"'],
  ['curl --token my\\ secret x', '--token my\\ secret'],
  ['API_KEY=my\\ secret x', 'API_KEY=my\\ secret'],
  ['--token=a\\ b S3CRET9', 'token=a\\ b'],
  ['curl --token "a\nS3CRET9" x', '--token "a\nS3CRET9"'],
  ["curl --token 'a\nS3CRET9' x", "--token 'a\nS3CRET9'"],
  ['curl -H "X-Auth-Token: abc123" x', 'X-Auth-Token: abc123'],
  ['mysql -psecret1 -psecret2', '-psecret1', '-psecret2'],
  ['tool --a-b-c-d-token abc123 x', '--a-b-c-d-token abc123'],
  [
    JSON.stringify(`aws_secret_access_key "${AWS_KEY}" x`),
    `aws_secret_access_key \\"${AWS_KEY}\\"`,
  ],
  ['curl --token S3\\\r\nCRET9 x', '--token S3\\\r\nCRET9'],
  ['mysql -u root -pS3CRET9<dump.sql', '-pS3CRET9'],
  ['mysql -h db 2>/dev/null -pS3CRET9 shop', '-pS3CRET9'],
  ['mysql -h db 2>&1 -pS3CRET9 shop', '-pS3CRET9'],
  ['mysql -h db &>/dev/null -pS3CRET9 shop', '-pS3CRET9'],
  ['curl -H \\"X-Api-Key: a"b c" x ; rm -rf /tmp/x', 'X-Api-Key: a"b c"'],
  [`aws_secret_access_key '${AWS_KEY}' x`, `aws_secret_access_key '${AWS_KEY}'`],
  ['PGPASSWORD=S3CRET9 psql -h db', 'PASSWORD=S3CRET9'],
  ['curl --token "abc && curl --password x\\ny', '--token "abc', '--password x\\ny'],
  ["# don't\ncurl --token 'S3CRET9' x", "--token 'S3CRET9'"],
  ["Don't pass --password 'hunter2' here", "--password 'hunter2'"],
  ["echo o'clock && mysql -u root -p'S3CRET9' shop\nls", "-p'S3CRET9'"],
  ["echo o'clock && tool --password 'S3'\"CR\"'ET9' x", "--password 'S3'\"CR\"'ET9'"],
  ["cat <<'EOF' > notes.md\nit's done\nEOF\ncurl --token 'S3CRET9' x", "--token 'S3CRET9'"],
  ['# --token \nabc\nls'],
  ['echo \\" && curl --token "a b" && rm -rf /tmp/x', '--token "a b"'],
  ["echo $'it\\'s' && curl --token a'b c'd x", "--token a'b c'd"],
  [JSON.stringify('curl --token S3CRET9\nrm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify('curl --token S3CRET9\trm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify('curl --token S3CRET9\r\nrm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify({ command: 'curl --token S3CRET9\\' }), '--token S3CRET9\\\\'],
  [`curl --token "${'a'.repeat(4096)}" x`, `--token "${'a'.repeat(4096)}"`],
  [`curl --token "${'a'.repeat(4097)}" x`],
  [`curl --token ab$c"${'a'.repeat(4097)}" x`, '--token ab$c'],
  ['docker run -p 8080:80 nginx'],
  ['git log -p'],
  ['tool --password-file x'],
  ['ls -p'],
  ['grep -p foo file.txt'],
  ['ssh -p 2222 host'],
  ['cp -p a b'],
  ['some-cli --token \\\n  --verbose'],
  ['some-cli --token \\\n--verbose'],
];

const cases = (rows: Row[]): [string, Row][] =>
  rows.map((row) => [JSON.stringify(row[0].length > 80 ? `${row[0].slice(0, 60)}…` : row[0]), row]);

describe('secret arguments', () => {
  it.each(cases([...KEEPS_COMMAND, ...REDACTS]))('redactSensitive() stores %s', (_title, row) => {
    expect(redactSensitive(row[0])).toBe(stored(row));
  });

  describe('processHook()', () => {
    const env = { ...process.env };
    let dir = '';

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'redaction-'));
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = dir;
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = join(dir, 'buffer.jsonl');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      process.env = { ...env };
    });

    function store(command: string): Record<string, unknown> {
      const hook = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
      processHook(JSON.stringify({ ...hook, session_id: 'sess-1', cwd: '/projects/test' }));
      const lines = readFileSync(join(dir, 'buffer.jsonl'), 'utf8').trim().split('\n');
      return (JSON.parse(lines[lines.length - 1]) as { toolInput: Record<string, unknown> })
        .toolInput;
    }

    it.each(cases(KEEPS_COMMAND))('stores %s and keeps it destructive', (_title, row) => {
      const toolInput = store(row[0]);
      expect(toolInput.command).toBe(stored(row));
      expect(parseToolSpecificFields('Bash', toolInput, undefined).bashDestructive).toBe(true);
    });

    it.each(cases(REDACTS))('stores %s', (_title, row) => {
      expect(store(row[0]).command).toBe(stored(row));
    });
  });
});

type Rand = () => number;

function parkMiller(seed: number): Rand {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

const pick = <T>(rand: Rand, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

// Digits mark the secret: no prefix, flag, separator or `rm -rf /tmp/x` contains one.
const marker = (rand: Rand): string => String(Math.floor(rand() * 99_999));

function fill(rand: Rand, extras: readonly string[]): string {
  let out = marker(rand);
  for (let n = Math.floor(rand() * 4); n > 0; n--) out += pick(rand, extras) + marker(rand);
  return out;
}

const BARE_ESCAPES = ['\\ ', '\\;', '\\|', '\\&', '\\(', '\\)', '\\<', '\\>', '\\`', '\\"', "\\'"];
const IN_DOUBLE = [' ', '\t', ';', '|', '&&', '(', ')', '<', '>', "'", '\\"', '\\\\', '\n', '\\\n'];
const IN_SINGLE = [' ', '\t', ';', '|', '&&', '(', ')', '"', '\\', '\n'];
const IN_ANSI = [' ', ';', '|', "\\'", '\\\\', '"'];

const PARTS: readonly ((rand: Rand) => string)[] = [
  (rand) => fill(rand, [...BARE_ESCAPES, '', '\\\\', '$']),
  (rand) => `"${fill(rand, IN_DOUBLE)}"`,
  (rand) => `'${fill(rand, IN_SINGLE)}'`,
  (rand) => `$'${fill(rand, IN_ANSI)}'`,
];

function shellWord(rand: Rand): string {
  let word = pick(rand, PARTS)(rand);
  for (let n = Math.floor(rand() * 3); n > 0; n--) {
    word += (rand() < 0.2 ? '\\\n' : '') + pick(rand, PARTS)(rand);
  }
  return word;
}

const FLAGS = [
  'curl --token |npm run deploy -- --password |deploy --api-key |deploy --client-secret ',
  '|deploy --db-password |tool --a-b-c-d-token |keytool -password |curl --token=|tool --api_key=',
  '|deploy --client-secret=|env API_KEY=|export TOKEN=|mysql -u root -p',
]
  .join('')
  .split('|');
const SEPARATORS = [';', '|', '&&', ')', '\n'];

function command(rand: Rand): string {
  const flag = pick(rand, FLAGS);
  const separator = pick(rand, SEPARATORS);
  const space = (): string => (rand() < 0.5 ? ' ' : '');
  const open = separator === ')' ? '(' : '';
  return `${open}${flag}${shellWord(rand)}${space()}${separator}${space()}rm -rf /tmp/x`;
}

describe('secret argument redaction over random shell words', () => {
  const SEED = 1164;
  const CASES = 2000;

  it.each([
    ['redactSensitive()', redactSensitive],
    ["the collector's redact()", redact],
  ])(
    '%s hides every secret character and keeps the rm after it classifiable',
    (_path, redactor) => {
      const rand = parkMiller(SEED);
      const failures: { command: string; stored: string }[] = [];
      for (let n = 0; n < CASES; n++) {
        const input = command(rand);
        const stored = redactor(input);
        if (/\d/.test(stored) || !classifyBash(stored).isDestructive) {
          failures.push({ command: input, stored });
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
