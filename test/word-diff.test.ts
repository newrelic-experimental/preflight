import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  editGroups,
  editName,
  isMainModule,
  loadLabels,
  parseCommand,
  parsePorcelain,
  renderMarkdown,
  renderPage,
  wordLines,
  type Line,
} from '../scripts/word-diff.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'word-diff-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `text` to `name` under the test's temp dir and returns its path. */
function makeFile(name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function unchanged(text: string): Line {
  return [[' ', text]];
}

const TAG = '<span class="tag">Edit 1</span>';

describe('wordLines', () => {
  it('splits a changed line into unchanged, deleted and inserted runs', () => {
    const original = makeFile('old/SKILL.md', 'one two three\nsame\n');
    const proposed = makeFile('new/SKILL.md', 'one 2 three\nsame\n');
    expect(wordLines(original, proposed)).toEqual([
      [
        [' ', 'one '],
        ['-', 'two'],
        ['+', '2'],
        [' ', ' three'],
      ],
      [[' ', 'same']],
    ]);
  });

  it('returns identical files as unchanged lines, with blank lines empty', () => {
    const original = makeFile('old/SKILL.md', 'a\n\nb\n');
    const proposed = makeFile('new/SKILL.md', 'a\n\nb\n');
    expect(wordLines(original, proposed)).toEqual([[[' ', 'a']], [], [[' ', 'b']]]);
  });

  it('shows a file with no original as all inserted', () => {
    const proposed = makeFile('new/NOTES.md', 'x y\n\nz\n');
    expect(wordLines(null, proposed)).toEqual([[['+', 'x y']], [], [['+', 'z']]]);
  });
});

describe('parsePorcelain', () => {
  it('skips the diff header and the no-newline marker', () => {
    const stdout =
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n~\n' +
      '\\ No newline at end of file\n';
    expect(parsePorcelain(stdout)).toEqual([
      [
        ['-', 'old'],
        ['+', 'new'],
      ],
    ]);
  });
});

describe('editGroups', () => {
  it('groups a run of changed lines, with the blank lines between them, into one edit', () => {
    const lines: Line[] = [
      unchanged('intro'),
      [['+', 'added']],
      unchanged(''),
      [
        [' ', 'a '],
        ['-', 'b'],
        ['+', 'c'],
      ],
      unchanged(''),
      unchanged('outro'),
      [['-', 'gone']],
    ];
    expect(editGroups(lines)).toEqual([
      [0, 1],
      [1, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ]);
  });
});

describe('labels', () => {
  it('gives an edit every label whose match it contains', () => {
    const labels = [
      ['First', 'a'],
      ['Second', 'c'],
      ['Third', 'z'],
    ] as const;
    expect(editName('a b c', labels, 1)).toBe('First, Second');
  });

  it('numbers the edits when there are no labels', () => {
    expect(editName('x', [], 3)).toBe('Edit 3');
  });

  it('tags an edit no label matches as Unlabeled, and shows a label that matches nothing nowhere', () => {
    const original = makeFile('old/SKILL.md', 'alpha\nkeep\nbeta\n');
    const proposed = makeFile('new/SKILL.md', 'alpha one\nkeep\nbeta two\n');
    const labels = makeFile(
      'labels.json',
      JSON.stringify([
        { label: 'Alpha', match: 'one' },
        { label: 'Nowhere', match: 'text in no edit' },
      ]),
    );
    const page = renderPage(original, proposed, labels, 'Proposed edits', false);
    expect(page).toContain('<option value="1">SKILL.md: Alpha</option>');
    expect(page).toContain('<option value="2">SKILL.md: Unlabeled</option>');
    expect(page).not.toContain('Nowhere');
  });

  it('reads no labels from a missing file and reports a malformed one as a label', () => {
    expect(loadLabels(join(dir, 'missing.json'))).toEqual([]);
    expect(loadLabels(makeFile('object.json', '{"label": "a", "match": "b"}'))).toEqual([
      ['labels file error: expected a JSON array', ''],
    ]);
    expect(loadLabels(makeFile('entry.json', '[{"match": "x"}]'))).toEqual([
      ['labels file error: each entry needs a string "label" and "match"', ''],
    ]);
  });
});

describe('parseCommand', () => {
  it('reads the command, both paths and the options', () => {
    expect(parseCommand(['serve', 'a', 'b', '--labels', 'l.json', '--port', '8080'])).toEqual({
      command: 'serve',
      original: 'a',
      proposed: 'b',
      labels: 'l.json',
      title: 'Proposed edits',
      port: 8080,
      output: undefined,
    });
    expect(parseCommand(['render', 'a', 'b', '-o', 'out.html'])).toMatchObject({
      output: 'out.html',
      port: 0,
    });
  });

  it('asks for help, and rejects what it cannot run', () => {
    expect(parseCommand(['-h'])).toBe('help');
    expect(parseCommand(['show', 'a', 'b'])).toEqual({
      error: "unknown command 'show': use serve or render",
    });
    expect(parseCommand(['render', 'a'])).toHaveProperty('error');
    expect(parseCommand(['render', 'a', 'b', '--port', 'x'])).toHaveProperty('error');
    expect(parseCommand(['render', 'a', 'b', '--bogus'])).toHaveProperty('error');
  });
});

describe('renderMarkdown', () => {
  it('keeps the word marks inside a list item', () => {
    const lines: Line[] = [
      [
        [' ', '- keep '],
        ['-', 'old'],
        ['+', 'new'],
        [' ', ' word'],
      ],
    ];
    expect(renderMarkdown(lines, [true], new Map([[0, 1]]), new Map([[1, TAG]]))).toBe(
      `<div class="rb"><ul><li class="chg" data-change="1">${TAG}` +
        'keep <del>old</del><ins>new</ins> word</li></ul></div>',
    );
  });

  it('keeps the word marks inside a table cell', () => {
    const lines: Line[] = [
      unchanged('| a | b |'),
      unchanged('|---|---|'),
      [
        [' ', '| x | '],
        ['-', '1'],
        ['+', '2'],
        [' ', ' |'],
      ],
    ];
    const html = renderMarkdown(
      lines,
      [false, false, true],
      new Map([[2, 1]]),
      new Map([[1, TAG]]),
    );
    expect(html).toBe(
      '<div class="rb"><table><tr><th>a</th><th>b</th></tr>' +
        `<tr class="chg" data-change="1"><td>${TAG}x</td><td><del>1</del><ins>2</ins></td></tr>` +
        '</table></div>',
    );
  });
});

describe('renderPage', () => {
  it('escapes HTML in the file text and the title', () => {
    const proposed = makeFile('new/NOTES.md', 'Run <script>alert(1)</script> now\n');
    const page = renderPage(join(dir, 'old/NOTES.md'), proposed, undefined, 'T <b>', false);
    expect(page).not.toContain('<script>alert');
    // Once in the raw view and once in the rendered one.
    expect(page.split('&lt;script&gt;alert(1)&lt;/script&gt;')).toHaveLength(3);
    expect(page).toContain('<title>T &lt;b&gt;</title>');
    expect(page).toContain('<h2 class="fh">NOTES.md (new file)</h2>');
  });
});

describe('isMainModule', () => {
  it('is false when the module is imported', () => {
    expect(isMainModule()).toBe(false);
  });
});
