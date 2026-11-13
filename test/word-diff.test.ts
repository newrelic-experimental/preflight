import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  editGroups,
  editName,
  escapeHtml,
  filePairs,
  isMainModule,
  loadLabels,
  pageVersion,
  parseCommand,
  parsePorcelain,
  renderInline,
  renderMarkdown,
  renderPage,
  route,
  wordLines,
  type Line,
  type ServeOptions,
} from '../scripts/word-diff.js';

const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'scripts', 'word-diff.ts');

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

function makeUnchangedLine(text: string): Line {
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

describe('filePairs', () => {
  it('walks a proposal directory: files before subdirectories, dotfiles skipped, a missing original as null', () => {
    makeFile('old/a.md', 'a\n');
    makeFile('old/sub/c.md', 'c\n');
    makeFile('new/b.md', 'b\n');
    makeFile('new/a.md', 'a2\n');
    makeFile('new/.labels.json', '[]');
    makeFile('new/sub/c.md', 'c2\n');
    expect(filePairs(join(dir, 'old'), join(dir, 'new'))).toEqual([
      { name: 'a.md', original: join(dir, 'old/a.md'), proposed: join(dir, 'new/a.md') },
      { name: 'b.md', original: null, proposed: join(dir, 'new/b.md') },
      {
        name: 'sub/c.md',
        original: join(dir, 'old/sub/c.md'),
        proposed: join(dir, 'new/sub/c.md'),
      },
    ]);
  });

  it('compares one file with one file, and rejects a proposed path that does not exist', () => {
    const proposed = makeFile('new/SKILL.md', 'x\n');
    expect(filePairs(join(dir, 'old/SKILL.md'), proposed)).toEqual([
      { name: 'SKILL.md', original: null, proposed },
    ]);
    expect(() => filePairs(dir, join(dir, 'nowhere'))).toThrow(/not a file or directory/);
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
      makeUnchangedLine('intro'),
      [['+', 'added']],
      makeUnchangedLine(''),
      [
        [' ', 'a '],
        ['-', 'b'],
        ['+', 'c'],
      ],
      makeUnchangedLine(''),
      makeUnchangedLine('outro'),
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

  it('reports a labels file that is not valid JSON as a label', () => {
    expect(loadLabels(makeFile('broken.json', '[{"label": "a",'))).toEqual([
      [expect.stringMatching(/^labels file error: \S/), ''],
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
    expect(parseCommand(['render', 'a', 'b', '--port', '65536'])).toHaveProperty('error');
    expect(parseCommand(['render', 'a', 'b', '--bogus'])).toHaveProperty('error');
  });
});

describe('escapeHtml', () => {
  it('escapes quotes for attributes unless told not to', () => {
    const text = `<a title="x" alt='y'>&</a>`;
    expect(escapeHtml(text)).toBe('&lt;a title=&quot;x&quot; alt=&#x27;y&#x27;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(text, false)).toBe(`&lt;a title="x" alt='y'&gt;&amp;&lt;/a&gt;`);
  });
});

describe('renderInline', () => {
  it('renders bold, both italics, links and code spans, escaping a link target for its attribute', () => {
    expect(renderInline('**b** *e* _u_ [x](a"b) `c <x>`')).toBe(
      '<strong>b</strong> <em>e</em> <em>u</em> <a href="a&quot;b">x</a> <code>c &lt;x&gt;</code>',
    );
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
      makeUnchangedLine('| a | b |'),
      makeUnchangedLine('|---|---|'),
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

describe('renderMarkdown block types', () => {
  it('renders front matter, headings, block quotes, code fences, rules and paragraphs', () => {
    const text = [
      '---',
      'name: x',
      '---',
      '# Title',
      '> quoted',
      '```',
      'code <b>',
      '```',
      '***',
      'plain **text**',
    ];
    const lines = text.map(makeUnchangedLine);
    expect(
      renderMarkdown(
        lines,
        lines.map(() => false),
        new Map(),
        new Map(),
      ),
    ).toBe(
      '<div class="rb"><pre class="fm">name: x</pre></div>' +
        '<div class="rb"><h1>Title</h1></div>' +
        '<div class="rb"><blockquote><p>quoted</p></blockquote></div>' +
        '<div class="rb"><pre><code>code &lt;b&gt;</code></pre></div>' +
        '<div class="rb"><hr></div>' +
        '<div class="rb"><p>plain <strong>text</strong></p></div>',
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

describe('serving', () => {
  function makeOptions(): ServeOptions {
    makeFile('old/SKILL.md', 'one two\n');
    makeFile('new/SKILL.md', 'one 2\n');
    return {
      original: join(dir, 'old'),
      proposed: join(dir, 'new'),
      labels: join(dir, 'labels.json'),
      title: 'Proposed edits',
      port: 0,
    };
  }

  it('serves the live page, its version, and nothing else', () => {
    const options = makeOptions();
    const [pageStatus, pageType, page] = route('GET', '/', options);
    expect([pageStatus, pageType]).toEqual([200, 'text/html']);
    expect(page).toContain('<del>two</del><ins>2</ins>');
    expect(page).toContain("fetch('/version'");
    expect(route('GET', '/version', options)).toEqual([
      200,
      'text/plain',
      pageVersion(options.original, options.proposed, options.labels),
    ]);
    expect(route('GET', '/SKILL.md', options)[0]).toBe(404);
    expect(route('GET', '/../old/SKILL.md', options)[0]).toBe(404);
    expect(route('POST', '/', options)[0]).toBe(501);
  });

  it('gives a new version when a compared file or the labels file changes, and only then', () => {
    const { original, proposed, labels } = makeOptions();
    const first = pageVersion(original, proposed, labels);
    makeFile('new/SKILL.md', 'one 2\n');
    expect(pageVersion(original, proposed, labels)).toBe(first);
    makeFile('new/SKILL.md', 'one 3\n');
    const second = pageVersion(original, proposed, labels);
    expect(second).not.toBe(first);
    makeFile('labels.json', '[]');
    expect(pageVersion(original, proposed, labels)).not.toBe(second);
  });
});

describe('isMainModule', () => {
  const originalArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('is false when the module is imported', () => {
    expect(isMainModule()).toBe(false);
  });

  it('is true when argv[1] is scripts/word-diff.ts', () => {
    process.argv[1] = script;
    expect(isMainModule()).toBe(true);
  });
});

describe('command line', () => {
  function makeRun(args: readonly string[]) {
    return spawnSync(resolve(repoRoot, 'node_modules', '.bin', 'tsx'), [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  }

  it('renders to the -o file and exits 0', () => {
    makeFile('old/SKILL.md', 'one two\n');
    makeFile('new/SKILL.md', 'one 2\n');
    const result = makeRun(['render', 'old', 'new', '-o', 'out.html']);
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, 'out.html'), 'utf8')).toContain('<del>two</del><ins>2</ins>');
  });

  it('prints the usage and exits 2 on a bad command line, and exits 1 on a missing path', () => {
    const usage = makeRun(['render', 'only-one']);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage:');
    const missing = makeRun(['render', 'old', 'nowhere']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('word-diff: not a file or directory');
  });
});
