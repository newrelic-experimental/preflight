#!/usr/bin/env tsx
/**
 * Render proposed edits as a word-level diff with highlighting. See
 * .claude/skills/preflight-review-pr/SKILL.md § 8.
 *
 *   npx tsx scripts/word-diff.ts serve  <original> <proposed> [--labels FILE] [--port N] [--title T]
 *   npx tsx scripts/word-diff.ts render <original> <proposed> [--labels FILE] [--title T] [-o OUT.html]
 *
 * Run it from the repo root. <original> and <proposed> are both files or both directories. For
 * directories, every file in <proposed> is compared with the file of the same relative path in
 * <original> (a missing original shows as all-new text), so the proposal directory only needs the
 * files you changed. Each file is shown in full, so every edit sits in the context of the rest of
 * the file. An edit is a run of changed lines, counting blank lines between them. Each edit is
 * tagged in the left margin with its label ("Edit N" without a labels file, "Unlabeled" for an
 * edit no label matches); the bar at the top has a stepper: the arrows (or j / k) move through the
 * edits in order, and the menu between them shows the current edit and jumps to any other. A
 * Raw / Rendered toggle (remembered across reloads) switches Markdown files between their source
 * and a rendered view; both keep the word-level marks. The renderer is a small built-in one
 * covering what skill files use: front matter, headings, nested lists, code fences, tables,
 * blockquotes, rules, and inline code, bold, italics and links.
 *
 * serve binds 127.0.0.1 only, prints `word-diff: serving http://127.0.0.1:<port>/` once
 * listening, and re-renders on every request. The page polls /version every second and reloads
 * itself, keeping its scroll position, whenever a compared file or the labels file changes. Stop
 * it with Ctrl-C or by killing the background task.
 *
 * --labels is an optional JSON array, re-read on each render, that tags edits with the numbers the
 * reasoning file uses:
 *   [{"label": "Edit 2", "match": "Re-review that will be an Approve"}]
 * An edit gets every label whose `match` text appears in it, so labels survive line shifts.
 *
 * Needs git (for --word-diff) and Node's standard library only. It was ported from a Python script
 * and renders the same pages byte for byte, which is why its Markdown patterns use Python's
 * whitespace and word characters (see "Python's character classes" below).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** How a run of text differs: unchanged (' '), deleted ('-') or inserted ('+'). */
export type Kind = ' ' | '-' | '+';

/** One run of a line's text, as `git diff --word-diff=porcelain` splits it. */
export type Segment = readonly [kind: Kind, text: string];

/** One line of the proposed file. A deleted line still appears, made only of '-' segments. */
export type Line = readonly Segment[];

/** A label from the labels file, and the text an edit must contain to get it. */
export type Label = readonly [label: string, match: string];

export interface FilePair {
  /** The name the page shows: the file's name, or its path relative to <proposed>. */
  readonly name: string;
  /** The original file, or null when the proposal adds the file. */
  readonly original: string | null;
  readonly proposed: string;
}

// --- Python's character classes -------------------------------------------------------------
// Python's whitespace (str.isspace(), str.strip() and re's \s) is a different set from
// JavaScript's \s and trim(), its \w and \d are Unicode where JavaScript's are ASCII, and its `.`
// matches everything but \n where JavaScript's also stops at \r and the Unicode line and
// paragraph separators. The Markdown patterns below spell out Python's sets, and use [^\n] for
// its `.`.

/**
 * The characters Python's str.isspace() accepts. None is special inside a regex character class,
 * so the patterns use them as they are.
 */
const WS = String.fromCodePoint(
  ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680],
  ...[0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a],
  ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000],
);
const SPACES = new Set(WS);
/** Python's \w, as the body of a regex character class (with the `u` flag). */
const WORD = String.raw`\p{L}\p{N}_`;

function lstrip(s: string): string {
  let i = 0;
  while (i < s.length && SPACES.has(s[i])) i += 1;
  return s.slice(i);
}

function strip(s: string): string {
  let end = s.length;
  while (end > 0 && SPACES.has(s[end - 1])) end -= 1;
  return lstrip(s.slice(0, end));
}

/** Python's str.__lt__ order: by code point, where JavaScript's sort compares UTF-16 units. */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** Python's html.escape(). */
export function escapeHtml(s: string, quote = true): string {
  const out = s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return quote ? out.replaceAll('"', '&quot;').replaceAll("'", '&#x27;') : out;
}

/** Python's text-mode universal newlines: \r\n and a lone \r both read as \n. */
function universalNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

// --- Inputs ---------------------------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every file in `dir`, as Python's os.walk lists them: sorted, files before subdirectories. */
function walk(dir: string, rel: string, original: string, out: FilePair[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name);
    // A link to a directory is not a file, and os.walk doesn't follow it.
    else if (!(entry.isSymbolicLink() && isDir(join(dir, entry.name)))) files.push(entry.name);
  }
  for (const name of files.sort(compareCodePoints)) {
    if (name.startsWith('.')) continue;
    const path = rel ? `${rel}/${name}` : name;
    const orig = join(original, path);
    out.push({ name: path, original: isFile(orig) ? orig : null, proposed: join(dir, name) });
  }
  for (const name of dirs.sort(compareCodePoints)) {
    walk(join(dir, name), rel ? `${rel}/${name}` : name, original, out);
  }
}

/** The files to compare, in a stable order. */
export function filePairs(original: string, proposed: string): FilePair[] {
  if (isFile(proposed)) {
    return [{ name: basename(proposed), original: isFile(original) ? original : null, proposed }];
  }
  if (!isDir(proposed)) throw new Error(`not a file or directory: ${proposed}`);
  const out: FilePair[] = [];
  walk(proposed, '', original, out);
  return out;
}

/**
 * The labels in the file at `path`: none when there is no such file, and a single label naming
 * the problem, which matches every edit, when the file isn't a JSON array of objects with a
 * string `label` and `match`.
 */
export function loadLabels(path: string | undefined): Label[] {
  if (!path || !isFile(path)) return [];
  const problem = (reason: string): Label[] => [[`labels file error: ${reason}`, '']];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    return problem(err instanceof Error ? err.message : String(err));
  }
  if (!Array.isArray(data)) return problem('expected a JSON array');
  const labels: Label[] = [];
  for (const entry of data) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('label' in entry && typeof entry.label === 'string') ||
      !('match' in entry && typeof entry.match === 'string')
    ) {
      return problem('each entry needs a string "label" and "match"');
    }
    labels.push([entry.label, entry.match]);
  }
  return labels;
}

/** The lines of a `git diff --word-diff=porcelain` hunk. */
export function parsePorcelain(stdout: string): Line[] {
  const lines: Segment[][] = [[]];
  let seen = false;
  for (const raw of stdout.split('\n')) {
    const kind = raw[0];
    if (raw.startsWith('@@ ')) seen = true;
    else if (!seen) continue;
    else if (raw === '~') lines.push([]);
    else if (kind === ' ' || kind === '-' || kind === '+') {
      lines[lines.length - 1].push([kind, raw.slice(1)]);
    }
  }
  // Porcelain ends every line with "~", which leaves one empty line after the last.
  while (lines.length && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/** The whole proposed file as lines of segments; a null original compares with an empty file. */
export function wordLines(original: string | null, proposed: string): Line[] {
  const text = universalNewlines(readFileSync(proposed, 'utf8'));
  const context = text.split('\n').length + 1; // enough context that git emits one hunk
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--no-color',
      '--word-diff=porcelain',
      `-U${context}`,
      original ?? '/dev/null',
      proposed,
    ],
    { encoding: 'utf8', maxBuffer: Infinity },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || 'git diff failed');
  }
  if (result.status === 0) {
    const plain = text.split('\n');
    if (plain.length && plain[plain.length - 1] === '') plain.pop();
    return plain.map((line): Line => (line ? [[' ', line]] : []));
  }
  return parsePorcelain(universalNewlines(result.stdout));
}

// --- Edits ----------------------------------------------------------------------------------

function isChanged(line: Line): boolean {
  return line.some(([kind]) => kind !== ' ');
}

function lineText(line: Line): string {
  return line.map(([, text]) => text).join('');
}

/**
 * Splits the lines into consecutive [start, end) ranges: each edit (a run of changed lines,
 * taking in blank lines between two changed lines) is one range, and every other line is a range
 * of its own.
 */
export function editGroups(lines: readonly Line[]): Array<readonly [start: number, end: number]> {
  const changed = lines.map(isChanged);
  const groups: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (changed[i] && j < lines.length) {
      if (changed[j]) {
        j += 1;
        continue;
      }
      let k = j;
      while (k < lines.length && !changed[k] && !strip(lineText(lines[k]))) k += 1;
      if (k < lines.length && changed[k]) j = k;
      else break;
    }
    const end = j > i ? j : i + 1;
    groups.push([i, end]);
    i = end;
  }
  return groups;
}

/**
 * The tag for edit `n`, whose text (every segment, deleted ones too) is `text`: every label whose
 * match appears in it, "Unlabeled" if none does, or "Edit n" when there are no labels.
 */
export function editName(text: string, labels: readonly Label[], n: number): string {
  const names = labels.filter(([, match]) => !match || text.includes(match)).map(([l]) => l);
  return names.join(', ') || (labels.length ? 'Unlabeled' : `Edit ${n}`);
}

// --- Markdown -------------------------------------------------------------------------------

// Private-use sentinels carry the word-level marks through Markdown parsing.
const [DEL_OPEN, DEL_CLOSE, INS_OPEN, INS_CLOSE] = [0xe000, 0xe001, 0xe002, 0xe003].map((cp) =>
  String.fromCodePoint(cp),
);
const MARK_TAGS = new Map([
  [DEL_OPEN, '<del>'],
  [DEL_CLOSE, '</del>'],
  [INS_OPEN, '<ins>'],
  [INS_CLOSE, '</ins>'],
]);
const SENTINEL = new RegExp(`[${DEL_OPEN}-${INS_CLOSE}]`, 'gu');

const LIST_ITEM = new RegExp(String.raw`^([${WS}]*)([-*+]|\p{Nd}+[.)])[${WS}]+`, 'u');
const TABLE_RULE = new RegExp(
  String.raw`^\|?[${WS}]*:?-+:?[${WS}]*(?:\|[${WS}]*:?-+:?[${WS}]*)*\|?$`,
  'u',
);
const HEADING = new RegExp(String.raw`^(#{1,6})[${WS}]+`, 'u');
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const CODE_SPAN = /(`[^`]+`)/u;
const LINK = new RegExp(String.raw`\[([^\]]+)\]\(([^)${WS}]+)\)`, 'gu');
const STRONG = /\*\*([^\n]+?)\*\*/gu;
const STAR_EM = new RegExp(
  String.raw`(?<![${WORD}*])\*(?![${WS}*])([^\n]+?)(?<![${WS}*])\*(?![${WORD}*])`,
  'gu',
);
const UNDERSCORE_EM = new RegExp(
  String.raw`(?<![${WORD}])_(?![${WS}_])([^\n]+?)(?<![${WS}_])_(?![${WORD}])`,
  'gu',
);

function marked(line: Line): string {
  const mark = ([kind, text]: Segment): string =>
    kind === '-' ? DEL_OPEN + text + DEL_CLOSE : kind === '+' ? INS_OPEN + text + INS_CLOSE : text;
  return line.map(mark).join('');
}

function visible(s: string): string {
  return s.replace(SENTINEL, '');
}

/** Drops the first `count` visible characters of a marked string, keeping its marks. */
function dropVisible(s: string, count: number): string {
  let out = '';
  let left = count;
  for (const c of s) {
    if (left > 0 && !MARK_TAGS.has(c)) left -= 1;
    else out += c;
  }
  return out;
}

function finish(s: string): string {
  return s.replace(SENTINEL, (c) => MARK_TAGS.get(c) ?? c);
}

/** Inline Markdown: code spans, links, bold and italics. */
export function renderInline(s: string): string {
  return s
    .split(CODE_SPAN)
    .map((part, i) => {
      if (i % 2) return `<code>${escapeHtml(part.slice(1, -1), false)}</code>`;
      return escapeHtml(part, false)
        .replace(
          LINK,
          (_match, text: string, href: string) =>
            `<a href="${escapeHtml(visible(href))}">${text}</a>`,
        )
        .replace(STRONG, '<strong>$1</strong>')
        .replace(STAR_EM, '<em>$1</em>')
        .replace(UNDERSCORE_EM, '<em>$1</em>');
    })
    .join('');
}

interface ListItem {
  readonly indent: number;
  readonly ordered: boolean;
  /** Each line of the item, with how many visible characters of it to drop. */
  readonly segments: Array<readonly [line: number, drop: number]>;
}

/**
 * Renders marked lines as HTML; blocks holding a changed line get the change highlight.
 * `starts` maps the first line of each edit to its number, and `tags` maps that number to its tag.
 */
export function renderMarkdown(
  lines: readonly Line[],
  changed: readonly boolean[],
  starts: ReadonlyMap<number, number>,
  tags: ReadonlyMap<number, string>,
): string {
  const L = lines.map(marked);
  const V = L.map(visible);
  const n = L.length;
  const out: string[] = [];

  const attrs = (a: number, b: number): [attrs: string, tags: string] => {
    if (!changed.slice(a, b).some(Boolean)) return ['', ''];
    const nums: number[] = [];
    for (let k = a; k < b; k += 1) {
      const num = starts.get(k);
      if (num !== undefined) nums.push(num);
    }
    return [
      ` class="chg" data-change="${nums.join(' ')}"`,
      nums.map((num) => tags.get(num) ?? '').join(''),
    ];
  };
  const block = (a: number, b: number, inner: string): void => {
    const [at, t] = attrs(a, b);
    const cls = at ? 'rb chg' : 'rb';
    out.push(`<div class="${cls}"${at.replaceAll(' class="chg"', '')}>${t}${inner}</div>`);
  };
  // Whitespace is all in the BMP, so these UTF-16 lengths are also code-point counts.
  const indent = (k: number): number => V[k].length - lstrip(V[k]).length;
  const special = (k: number): boolean => {
    const s = strip(V[k]);
    return !s || /^(?:#|```|>|\|)/.test(s) || LIST_ITEM.test(V[k]) || RULE.test(s);
  };

  let i = 0;
  if (n && strip(V[0]) === '---') {
    let j = 1;
    while (j < n && strip(V[j]) !== '---') j += 1;
    if (j < n) {
      const body = L.slice(1, j).map((line) => escapeHtml(line, false));
      block(0, j + 1, `<pre class="fm">${body.join('\n')}</pre>`);
      i = j + 1;
    }
  }
  while (i < n) {
    const v = V[i];
    const s = strip(v);
    const heading = HEADING.exec(s);
    if (!s) {
      i += 1;
    } else if (s.startsWith('```')) {
      let j = i + 1;
      while (j < n && !strip(V[j]).startsWith('```')) j += 1;
      const ind = indent(i);
      const body: string[] = [];
      for (let k = i + 1; k < Math.min(j, n); k += 1) {
        body.push(escapeHtml(dropVisible(L[k], Math.min(ind, indent(k))), false));
      }
      block(i, Math.min(j + 1, n), `<pre><code>${body.join('\n')}</code></pre>`);
      i = j + 1;
    } else if (heading) {
      const level = heading[1].length;
      const text = renderInline(dropVisible(L[i], indent(i) + heading[0].length));
      block(i, i + 1, `<h${level}>${text}</h${level}>`);
      i += 1;
    } else if (RULE.test(s)) {
      block(i, i + 1, '<hr>');
      i += 1;
    } else if (s.startsWith('|') && i + 1 < n && TABLE_RULE.test(strip(V[i + 1]))) {
      const rows: string[] = [];
      let j = i;
      while (j < n && strip(V[j]).startsWith('|')) {
        if (j !== i + 1) {
          let cells = strip(L[j]).split('|');
          if (cells.length && !strip(visible(cells[0]))) cells = cells.slice(1);
          if (cells.length && !strip(visible(cells[cells.length - 1]))) cells = cells.slice(0, -1);
          const cell = j === i ? 'th' : 'td';
          const [at, t] = attrs(j, j + 1);
          const tds = cells.map(
            (c, ci) => `<${cell}>${ci === 0 ? t : ''}${renderInline(strip(c))}</${cell}>`,
          );
          rows.push(`<tr${at}>${tds.join('')}</tr>`);
        }
        j += 1;
      }
      out.push(`<div class="rb"><table>${rows.join('')}</table></div>`);
      i = j;
    } else if (s.startsWith('>')) {
      let j = i;
      while (j < n && strip(V[j]).startsWith('>')) j += 1;
      const text: string[] = [];
      for (let k = i; k < j; k += 1) {
        const quoted = strip(V[k]);
        const marker = quoted.length - lstrip(quoted.replace(/^>+/, '')).length;
        text.push(dropVisible(L[k], indent(k) + marker));
      }
      block(i, j, `<blockquote><p>${renderInline(text.join(' '))}</p></blockquote>`);
      i = j;
    } else if (LIST_ITEM.test(v)) {
      const items: ListItem[] = [];
      let j = i;
      while (j < n) {
        const m = LIST_ITEM.exec(V[j]);
        if (m) {
          // The marker can hold astral digits, so count its code points.
          const drop = Array.from(m[0]).length;
          const ordered = !['-', '*', '+'].includes(m[2][0]);
          items.push({ indent: m[1].length, ordered, segments: [[j, drop]] });
          j += 1;
        } else if (!strip(V[j])) {
          let k = j + 1;
          while (k < n && !strip(V[k])) k += 1;
          if (k < n && (LIST_ITEM.test(V[k]) || indent(k) >= 2)) j = k;
          else break;
        } else if (indent(j) >= 2 && !strip(V[j]).startsWith('```')) {
          items[items.length - 1].segments.push([j, indent(j)]);
          j += 1;
        } else {
          break;
        }
      }
      const parts: string[] = [];
      const stack: Array<readonly [indent: number, tag: string]> = [];
      const close = (): void => {
        const top = stack.pop();
        if (top) parts.push(`</li></${top[1]}>`);
      };
      for (const { indent: ind, ordered, segments } of items) {
        const tag = ordered ? 'ol' : 'ul';
        while (stack.length && ind < stack[stack.length - 1][0]) close();
        if (stack.length && ind === stack[stack.length - 1][0]) {
          parts.push('</li>');
        } else {
          parts.push(`<${tag}>`);
          stack.push([ind, tag]);
        }
        const [at, t] = attrs(segments[0][0], segments[segments.length - 1][0] + 1);
        const text = segments.map(([k, drop]) => dropVisible(L[k], drop)).join(' ');
        parts.push(`<li${at}>${t}${renderInline(text)}`);
      }
      while (stack.length) close();
      out.push(`<div class="rb">${parts.join('')}</div>`);
      i = j;
    } else {
      let j = i + 1;
      while (j < n && !special(j)) j += 1;
      const text: string[] = [];
      for (let k = i; k < j; k += 1) text.push(dropVisible(L[k], indent(k)));
      block(i, j, `<p>${renderInline(text.join(' '))}</p>`);
      i = j;
    }
  }
  return finish(out.join(''));
}

// --- Page -----------------------------------------------------------------------------------

const STYLE = `
body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.3rem}
h2.fh{font-size:1rem;font-family:ui-monospace,monospace}
.loc{color:#656d76;font-weight:normal}
section{position:relative;border:1px solid #d0d7de;border-radius:6px;padding:1rem 1rem 1rem 7rem;margin:1rem 0}
h2.fh{position:sticky;top:var(--nav-h,2.4rem);z-index:2;margin:-1rem -1rem .5rem -7rem;padding:.5rem 1rem;background:#f6f8fa;border-bottom:1px solid #d0d7de;border-radius:6px 6px 0 0}
.tag{position:absolute;left:.5rem;width:6rem;box-sizing:border-box;text-align:right;white-space:normal;
  font:600 .75rem/1.4 system-ui,sans-serif;color:#0550ae;background:#ddf4ff;border-radius:4px;padding:1px 6px}
.cur .tag{background:#0969da;color:#fff}
nav{position:sticky;top:0;background:inherit;padding:.4rem 0;z-index:3;font-size:.85rem;display:flex;justify-content:flex-end;align-items:center;gap:.6rem;min-height:1.6rem}
.stepper{font-size:.8rem;border:1px solid #d0d7de;border-radius:6px;display:inline-flex;align-items:center}
.stepper button{font:inherit;border:0;background:transparent;color:inherit;padding:2px 8px;cursor:pointer}
.stepper button:hover{background:#eaeef2}
.stepper select{font:inherit;color:inherit;background:transparent;border:0;border-left:1px solid #d0d7de;padding:2px 4px 2px 8px;max-width:22em;cursor:pointer} .stepper .pos{padding:0 .4rem;min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums}
.cur.line .tx,.md .cur{outline:2px solid #0969da;outline-offset:-2px}
.line{display:flex;font-family:ui-monospace,monospace;font-size:13px;line-height:1.5}
.ln{flex:0 0 3.2em;text-align:right;padding-right:.8em;color:#8c959f;user-select:none}
.tx{flex:1;white-space:pre-wrap;word-break:break-word;padding-left:.5em;border-left:3px solid transparent}
.chg .tx{border-left-color:#d4a72c;background:#fff8c5} .start{scroll-margin-top:calc(var(--nav-h,2.4rem) + 3rem)}
.toggle{font-size:.8rem;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}
.toggle button{font:inherit;border:0;background:transparent;color:inherit;padding:2px 10px;cursor:pointer}
.toggle button.on{background:#0969da;color:#fff}
body.mode-raw .view.rendered,body.mode-rendered .view.raw{display:none}
.md{font-size:15px;line-height:1.6} .md .rb{padding-left:.7em;border-left:3px solid transparent;margin:0}
.md .chg,.md li.chg,.md tr.chg{border-left:3px solid #d4a72c;background:#fff8c5}
.md li.chg{padding-left:.3em} .md .chg[data-change]{scroll-margin-top:calc(var(--nav-h,2.4rem) + 3rem)}
.md pre{background:#f6f8fa;padding:.6em .8em;border-radius:6px;overflow:auto;font-size:13px}
.md pre.fm{color:#656d76} .md code{font-family:ui-monospace,monospace;font-size:85%;background:#eff1f3;padding:.1em .3em;border-radius:4px}
.md pre code{background:none;padding:0} .md table{border-collapse:collapse;margin:.5em 0}
.md th,.md td{border:1px solid #d0d7de;padding:.3em .6em;vertical-align:top}
.md blockquote{margin:0;padding:0 1em;color:#656d76;border-left:.25em solid #d0d7de}
.md h1,.md h2,.md h3,.md h4{font-family:inherit;margin:.8em 0 .4em} .md h2{font-size:1.25rem} .md h3{font-size:1.1rem}
del{background:#ffd7d5;color:#82071e;text-decoration:line-through} ins{background:#ccffd8;color:#055d20;text-decoration:none}
.empty{color:#656d76;font-style:italic}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}section{border-color:#30363d}
h2.fh{background:#161b22;border-bottom-color:#30363d}
.tag{background:#1f2a44;color:#79c0ff}.cur .tag{background:#1f6feb;color:#fff}.stepper,.stepper select{border-color:#30363d}.stepper select option{background:#0d1117}.stepper button:hover{background:#21262d}
.chg .tx{border-left-color:#bb8009;background:#bb800926}.ln{color:#6e7681}
.toggle{border-color:#30363d}.toggle button.on{background:#1f6feb}
.md .chg,.md li.chg,.md tr.chg{border-left-color:#bb8009;background:#bb800926}
.md pre{background:#161b22}.md code{background:#343a40}.md th,.md td{border-color:#30363d}.md blockquote{border-left-color:#30363d;color:#8b949e}
del{background:#67060c80;color:#ffdcd7}ins{background:#03380080;color:#aff5b4}.loc,.empty{color:#8b949e}}
`;

const SCRIPT = `<script>
(function(){
  var bar=document.querySelector('nav');
  function navH(){if(bar)document.documentElement.style.setProperty('--nav-h',bar.offsetHeight+'px')}
  navH(); window.addEventListener('resize',navH);
  var mk='word-diff-mode', mode=localStorage.getItem(mk)||'rendered';
  function set(m){mode=m;localStorage.setItem(mk,m);document.body.className='mode-'+m;
    document.querySelectorAll('.toggle button').forEach(function(b){b.classList.toggle('on',b.dataset.mode===m)});}
  set(mode);
  document.querySelectorAll('.toggle button').forEach(function(b){b.onclick=function(){
    set(b.dataset.mode); if(cur>=0){var t=target(links[cur].value); if(t)t.scrollIntoView({block:'start'})}}});
  var menu=document.querySelector('.stepper select'), links=menu?[].slice.call(menu.options).slice(1):[], cur=-1;
  var pos=document.querySelector('.stepper .pos');
  function target(c){
    var els=document.querySelectorAll('section [data-change~="'+c+'"]');
    for(var i=0;i<els.length;i++){if(els[i].offsetParent!==null)return els[i]}
  }
  function go(i){
    if(!links.length)return;
    cur=(i+links.length)%links.length;
    var c=links[cur].value;
    document.querySelectorAll('.cur').forEach(function(e){e.classList.remove('cur')});
    menu.selectedIndex=cur+1;
    document.querySelectorAll('section [data-change~="'+c+'"]').forEach(function(e){e.classList.add('cur')});
    var t=target(c); if(t)t.scrollIntoView({block:'start'});
    if(pos)pos.textContent=(cur+1)+' / '+links.length;
    sessionStorage.setItem('word-diff-cur',String(cur));
  }
  if(menu)menu.onchange=function(){if(menu.selectedIndex>0)go(menu.selectedIndex-1)};
  document.querySelectorAll('.stepper button').forEach(function(b){b.onclick=function(){go(cur<0&&+b.dataset.step<0?links.length-1:cur+(+b.dataset.step))}});
  document.addEventListener('keydown',function(e){
    if(e.metaKey||e.ctrlKey||e.altKey||/INPUT|TEXTAREA/.test(e.target.tagName))return;
    if(e.key==='j'){go(cur+1)}else if(e.key==='k'){go(cur<0?links.length-1:cur-1)}
  });
  var saved=sessionStorage.getItem('word-diff-cur');
  if(saved!==null&&links.length){
    var y=window.scrollY; go(Math.min(+saved,links.length-1)); window.scrollTo(0,y);
  }

})();
</script>`;

const RELOAD = `<script>
(function(){
  var key='word-diff-scroll:'+location.pathname, v=null;
  var y=sessionStorage.getItem(key); if(y!==null){window.scrollTo(0,+y);sessionStorage.removeItem(key);}
  setInterval(function(){
    fetch('/version',{cache:'no-store'}).then(function(r){return r.text()}).then(function(t){
      if(v===null){v=t;return}
      if(t!==v){sessionStorage.setItem(key,String(window.scrollY));location.reload();}
    }).catch(function(){});
  },1000);
})();
</script>`;

/** The whole page. `live` adds the script that reloads it when /version changes. */
export function renderPage(
  original: string,
  proposed: string,
  labelsPath: string | undefined,
  title: string,
  live: boolean,
): string {
  const labels = loadLabels(labelsPath);
  const sections: string[] = [];
  const links: string[] = [];
  let n = 0;
  let anyMarkdown = false;
  for (const pair of filePairs(original, proposed)) {
    const lines = wordLines(pair.original, pair.proposed);
    const changed = lines.map(isChanged);
    const starts = new Map<number, number>();
    const tags = new Map<number, string>();
    const rows: string[] = [];
    let newno = 0;
    for (const [i, end] of editGroups(lines)) {
      let tagHtml = '';
      let data = '';
      if (changed[i]) {
        n += 1;
        starts.set(i, n);
        const name = editName(lines.slice(i, end).map(lineText).join(''), labels, n);
        tagHtml = `<span class="tag">${escapeHtml(name)}</span>`;
        tags.set(n, tagHtml);
        data = ` data-change="${n}"`;
        links.push(`<option value="${n}">${escapeHtml(pair.name)}: ${escapeHtml(name)}</option>`);
      }
      for (let k = i; k < end; k += 1) {
        const line = lines[k];
        let num = '';
        if (line.some(([kind]) => kind !== '-') || !line.length) {
          newno += 1;
          num = String(newno);
        }
        const parts = line.map(([kind, text]) => {
          const t = escapeHtml(text);
          return kind === '-' ? `<del>${t}</del>` : kind === '+' ? `<ins>${t}</ins>` : t;
        });
        const cls = changed[k] ? `line chg${k === i && changed[i] ? ' start' : ''}` : 'line';
        rows.push(
          `<div class="${cls}"${data}><span class="ln">${num}</span>` +
            `<span class="tx">${k === i ? tagHtml : ''}${parts.join('') || '&nbsp;'}</span></div>`,
        );
      }
    }
    const isNew = pair.original === null ? ' (new file)' : '';
    const raw = rows.join('');
    const lower = pair.name.toLowerCase();
    let body = raw;
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      anyMarkdown = true;
      body =
        `<div class="view raw">${raw}</div>` +
        `<div class="view rendered md">${renderMarkdown(lines, changed, starts, tags)}</div>`;
    }
    sections.push(`<section><h2 class="fh">${escapeHtml(pair.name)}${isNew}</h2>${body}</section>`);
  }
  const toggle = anyMarkdown
    ? '<span class="toggle"><button data-mode="raw">Raw</button>' +
      '<button data-mode="rendered">Rendered</button></span>'
    : '';
  const stepper = links.length
    ? '<span class="stepper"><button data-step="-1" title="Previous edit (k)">&uarr;</button>' +
      `<select title="Jump to an edit"><option value="" disabled selected>Edits</option>${links.join('')}</select>` +
      `<span class="pos">&ndash; / ${links.length}</span>` +
      '<button data-step="1" title="Next edit (j)">&darr;</button></span>'
    : '';
  const nav = links.length
    ? `<nav>${stepper}${toggle}</nav>`
    : `<nav>${toggle}</nav><p class="empty">No differences between the original and proposed files.</p>`;
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style>` +
    `<body class="mode-rendered"><h1>${escapeHtml(title)}</h1>${nav}` +
    sections.join('') +
    SCRIPT +
    (live ? RELOAD : '')
  );
}

/** A hash of every compared file and the labels file, which changes when any of them does. */
export function pageVersion(
  original: string,
  proposed: string,
  labelsPath: string | undefined,
): string {
  const hash = createHash('sha1');
  const paths: string[] = [];
  for (const pair of filePairs(original, proposed)) {
    if (pair.original) paths.push(pair.original);
    paths.push(pair.proposed);
  }
  if (labelsPath) paths.push(labelsPath);
  for (const path of paths) {
    hash.update(path, 'utf8');
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}

// --- Server ---------------------------------------------------------------------------------

export interface ServeOptions {
  readonly original: string;
  readonly proposed: string;
  readonly labels: string | undefined;
  readonly title: string;
  readonly port: number;
}

/** The status, content type and body for a request. */
export function route(
  method: string | undefined,
  path: string,
  options: ServeOptions,
): readonly [status: number, type: string, body: string] {
  const { original, proposed, labels, title } = options;
  if (method !== 'GET') return [501, 'text/plain', 'Not implemented\n'];
  if (path === '/version') return [200, 'text/plain', pageVersion(original, proposed, labels)];
  if (path === '/') return [200, 'text/html', renderPage(original, proposed, labels, title, true)];
  return [404, 'text/plain', 'Not found\n'];
}

function respond(req: IncomingMessage, res: ServerResponse, options: ServeOptions): void {
  let reply: readonly [number, string, string];
  try {
    reply = route(req.method, (req.url ?? '').split('?', 1)[0], options);
  } catch (err: unknown) {
    // The request fails and the server keeps serving.
    const message = `word-diff: ${err instanceof Error ? err.message : String(err)}`;
    console.error(message);
    reply = [500, 'text/plain', `${message}\n`];
  }
  const [status, type, body] = reply;
  const data = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Content-Length': data.length,
  });
  res.end(data);
}

function serve(options: ServeOptions): void {
  const server = createServer((req, res) => respond(req, res, options));
  server.on('error', (err) => {
    console.error(`word-diff: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : options.port;
    console.log(`word-diff: serving http://127.0.0.1:${port}/`);
  });
}

// --- Command line ---------------------------------------------------------------------------

const USAGE = `usage:
  npx tsx scripts/word-diff.ts serve  <original> <proposed> [--labels FILE] [--port N] [--title T]
  npx tsx scripts/word-diff.ts render <original> <proposed> [--labels FILE] [--title T] [-o OUT.html]
`;

export interface Options {
  readonly command: 'serve' | 'render';
  readonly original: string;
  readonly proposed: string;
  readonly labels?: string;
  readonly title: string;
  readonly port: number;
  readonly output?: string;
}

/** What `argv` asks for: options to run with, 'help', or why it can't run. */
export function parseCommand(
  argv: readonly string[],
): Options | 'help' | { readonly error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        labels: { type: 'string' },
        title: { type: 'string', default: 'Proposed edits' },
        port: { type: 'string', default: '0' },
        output: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  if (positionals.length !== 3) return { error: 'expected a command, <original> and <proposed>' };
  const [command, original, proposed] = positionals;
  if (command !== 'serve' && command !== 'render') {
    return { error: `unknown command '${command}': use serve or render` };
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) {
    return { error: '--port must be a whole number from 0 to 65535' };
  }
  const { labels, title, output } = values;
  return { command, original, proposed, labels, title, port, output };
}

function main(argv: readonly string[]): void {
  const parsed = parseCommand(argv);
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if ('error' in parsed) {
    process.stderr.write(`word-diff: ${parsed.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const original = resolve(parsed.original);
  const proposed = resolve(parsed.proposed);
  const labels = parsed.labels ? resolve(parsed.labels) : undefined;
  if (parsed.command === 'serve') {
    serve({ original, proposed, labels, title: parsed.title, port: parsed.port });
    return;
  }
  const page = renderPage(original, proposed, labels, parsed.title, false);
  if (parsed.output) writeFileSync(parsed.output, page, 'utf8');
  else process.stdout.write(page);
}

// Uses process.argv[1] rather than import.meta.url, which ts-jest's CommonJS output can't
// parse, so the test file can import this module without running it.
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry).endsWith(join('scripts', 'word-diff.ts'));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`word-diff: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
