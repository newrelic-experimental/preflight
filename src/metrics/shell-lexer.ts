/**
 * How Preflight reads a Bash command before classifying it. The heredoc bodies
 * it drops and the segments it splits come from the same scan, so they never
 * disagree about which text is quoted, commented or escaped.
 */
export interface ShellReading {
  /** The command without its heredoc bodies, so a script piped inline
   *  (`python3 - <<'PY' ...`) that mentions git words is not read as git
   *  commands. The line introducing a heredoc stays: `git commit -F- <<'MSG'`
   *  is still a commit. */
  readonly text: string;
  /** `text` split on its `||`, `&&`, `;`, `|`, `&` and newline operators:
   *  `operators[i]` joins `segments[i]` to `segments[i + 1]`. Segments are not
   *  trimmed, comments are left out of them, a backslash-newline joins two
   *  lines, and after `||`, `&&` or `|` the line breaks and comment lines
   *  before the next command are skipped. `|&` is reported as `|`, and the
   *  `&` of a redirection (`2>&1`, `&>file`) is not an operator. An operator
   *  inside `( … )` splits; one inside quotes, `"$( … )"` included, does not. */
  readonly segments: readonly string[];
  readonly operators: readonly string[];
  /** True when a heredoc never reached its terminator line, so every line
   *  after its `<<` was dropped. Heredocs that agents write close, so this
   *  usually means a `<<` that bash doesn't read as a heredoc was taken for
   *  one, such as `$((1<<N))`, and the text left is not what bash ran. */
  readonly unclosed: boolean;
  /** True when taking a quoted or commented `<<` for a heredoc changes which
   *  lines are kept, as when a `<<` sits in quoted text. Which lines bash ran
   *  then rests on a quote reading that can be wrong (`$'it\'s'`), so `text`
   *  may not be what ran. */
  readonly readingsDiffer: boolean;
  /** False when a quote or `( … )` group never closed. bash refuses such a
   *  command, so meeting one in a command that ran means this scan misread
   *  it, as it does `$'it\'s'`. The command is then split on every operator,
   *  quoted or commented, which keeps every command it holds, and where each
   *  segment ends is a guess. */
  readonly balanced: boolean;
}

// How a scan reads quotes, `( … )` groups and `#` comments, and which `<<` it
// takes for a heredoc. `bash` reads them as bash does. `every-heredoc` reads
// them the same way but also takes a quoted or commented `<<` for a heredoc,
// so a misread quote cannot hide a real one. `blind` reads quotes and groups
// as plain text, and every `<<` as a heredoc. Its `#` is still a comment
// after `||`, `&&` or `|` when a later line follows, as bash reads it.
type ScanMode = 'bash' | 'every-heredoc' | 'blind';

type Scan = Omit<ShellReading, 'readingsDiffer'>;

/**
 * Reads `command` the way bash does. When that reading leaves a heredoc open
 * or a quote unbalanced, or a quoted `<<` would change which lines are kept,
 * the reading that drops more is taken instead, so a misread errs toward
 * missing a command rather than inventing one from a script body. The
 * every-`<<` reading is replaced only when bash's reading balances and closes
 * every heredoc while the every-`<<` one leaves one open, so a `<<` in quoted
 * text (`--body "see <<X"`) drops no lines. A quoted `<<` that a real
 * heredoc's terminator closes leaves the every-`<<` reading closed but
 * missing lines; `readingsDiffer` reports that.
 */
export function readShell(command: string): ShellReading {
  const bash = scan(command, 'bash');
  const every = command.includes('<<') ? scan(command, 'every-heredoc') : bash;
  const bashCloses = bash.balanced && !bash.unclosed;
  const chosen = bashCloses && (every.unclosed || every.text === bash.text) ? bash : every;
  const reading = chosen.balanced ? chosen : { ...scan(command, 'blind'), balanced: false };
  return { ...reading, readingsDiffer: every.text !== bash.text };
}

// `<<` or `<<-` and its delimiter word, but not the `<<<` of a here-string.
const HEREDOC_START_RE =
  /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/y;

// Characters that end a word, so a `#` after one starts a comment. `)` is left
// out because it also closes a `$( … )` inside a word.
const WORD_BREAK_RE = /[ \t(<>]/;

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

function scan(command: string, mode: ScanMode): Scan {
  const readQuotes = mode !== 'blind';
  const segments: string[] = [];
  const operators: string[] = [];
  const kept: string[] = [];
  let keptFrom = 0;
  const pending: PendingHeredoc[] = [];
  // Open quotes and `(`/`$(` groups, innermost last.
  const open: string[] = [];
  let current = '';
  let wordStart = true;
  // After `||`, `&&` or `|` bash reads past line breaks, blank lines and
  // comment lines to the rest of the command.
  let continuing = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const inner = open.at(-1);
    if (ch === '<' && (mode !== 'bash' || (inner !== "'" && inner !== '"'))) {
      const end = openHeredoc(command, i, pending);
      if (end !== -1) {
        current += command.slice(i, end);
        wordStart = false;
        continuing = false;
        i = end - 1;
        continue;
      }
    }
    if (ch === '\n' && pending.length > 0) {
      kept.push(command.slice(keptFrom, i));
      i = heredocBodiesEnd(command, i, pending);
      keptFrom = i;
      if (i === command.length) break;
    }
    if (inner === "'") {
      current += ch;
      if (ch === "'") open.pop();
      continue;
    }
    if (ch === '\\') {
      if (command[i + 1] !== '\n') {
        current += command.slice(i, i + 2);
        wordStart = false;
      }
      continuing = false;
      i++;
      continue;
    }
    if (inner === '"') {
      current += ch;
      if (ch === '"') {
        open.pop();
      } else if (command.startsWith('$(', i)) {
        open.push('(');
        current += '(';
        i++;
      }
      continue;
    }
    const startsComment = readQuotes ? wordStart : continuing && command.includes('\n', i);
    if (ch === '#' && startsComment) {
      const lineEnd = command.indexOf('\n', i);
      const end = lineEnd === -1 ? command.length : lineEnd;
      if (mode !== 'bash') openHeredocsIn(command, i, end, pending);
      i = end - 1;
      continue;
    }
    if (readQuotes) {
      if (ch === "'" || ch === '"') {
        open.push(ch);
        current += ch;
        wordStart = false;
        continuing = false;
        continue;
      }
      // A `(` opens a group only where bash reads one: at the start of a
      // word or after `$`. Mid-word, as in `${x//(/}`, it is plain text.
      if (ch === '(' && (wordStart || command[i - 1] === '$')) open.push(ch);
      else if (ch === ')' && inner === '(') open.pop();
    }
    const token = operatorAt(command, i);
    if (token === null) {
      current += ch;
      wordStart = WORD_BREAK_RE.test(ch);
      if (ch !== ' ' && ch !== '\t') continuing = false;
      continue;
    }
    i += token.length - 1;
    wordStart = true;
    if (open.includes('"')) {
      current += token;
      continue;
    }
    if (token === '\n' && continuing) {
      current = '';
      continue;
    }
    segments.push(current);
    operators.push(token === '|&' ? '|' : token);
    current = '';
    continuing = token !== ';' && token !== '\n' && token !== '&';
  }

  segments.push(current);
  kept.push(command.slice(keptFrom));
  return {
    text: kept.join(''),
    segments,
    operators,
    unclosed: pending.length > 0,
    balanced: open.length === 0,
  };
}

/** The operator starting at `i`, as written, or null when none does. */
function operatorAt(command: string, i: number): string | null {
  const pair = command.slice(i, i + 2);
  if (pair === '||' || pair === '&&' || pair === '|&') return pair;
  const ch = command[i];
  if (ch === '|' || ch === ';' || ch === '\n') return ch;
  const redirects = command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>';
  return ch === '&' && !redirects ? ch : null;
}

/** Where the heredoc start at `i` ends, after pushing it onto `pending`, or
 *  -1 when none starts there. */
function openHeredoc(command: string, i: number, pending: PendingHeredoc[]): number {
  HEREDOC_START_RE.lastIndex = i;
  const match = HEREDOC_START_RE.exec(command);
  if (!match) return -1;
  pending.push({ delimiter: match[2] ?? match[3] ?? match[4]!, stripTabs: match[1] === '-' });
  return HEREDOC_START_RE.lastIndex;
}

function openHeredocsIn(
  command: string,
  from: number,
  to: number,
  pending: PendingHeredoc[],
): void {
  for (let i = command.indexOf('<', from); i !== -1 && i < to; i = command.indexOf('<', i + 1)) {
    const end = openHeredoc(command, i, pending);
    if (end !== -1) i = end - 1;
  }
}

/** The line break ending the terminator line of the last heredoc in
 *  `pending`, whose bodies start after the line break at `newline`, or
 *  `command.length` when the command ends first. Closed heredocs leave
 *  `pending`. */
function heredocBodiesEnd(command: string, newline: number, pending: PendingHeredoc[]): number {
  let end = newline;
  while (pending.length > 0 && end < command.length) {
    const lineStart = end + 1;
    const lineEnd = command.indexOf('\n', lineStart);
    end = lineEnd === -1 ? command.length : lineEnd;
    const line = command.slice(lineStart, end);
    const heredoc = pending[0]!;
    // bash ends a heredoc only on a line that is exactly its delimiter; `<<-`
    // strips leading tabs, not spaces. A trailing `\r` is a CRLF line end.
    const candidate = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
    if (candidate === heredoc.delimiter) pending.shift();
  }
  return pending.length > 0 ? command.length : end;
}
