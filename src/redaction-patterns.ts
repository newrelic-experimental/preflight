// Canonical secret-redaction patterns. Shared by src/config.ts's redactSensitive()
// (used across the MCP server) and src/hooks/collector-script.ts's redact() (the hot-path
// hook binary, <5ms budget per invocation — this array literal has no runtime cost beyond
// what each consumer already pays). Previously these were two independently-maintained
// copies that silently drifted: collector-script.ts's list fell 8 patterns behind this one.
// Import from here rather than redefining — a single source of truth makes that drift
// structurally impossible.

// JSON escapes, ANSI colour codes and percent-escapes end in a letter or digit, so a flag
// right after one would otherwise look like the middle of a word.
const AFTER_ESCAPE = String.raw`\\[nrtbf]|\\u[0-9a-fA-F]{4}|(?:\x1b|\\u001[bB])\[[0-9;]{0,20}m|%[0-9a-fA-F]{2}`;
const CONTINUATION = String.raw`(?:\\\r?\n|\\\\\\n)`;

export const REDACTION_PATTERNS: readonly RegExp[] = [
  /(?:sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-|Bearer\s+)[A-Za-z0-9_-]{20,200}/g,
  /-----BEGIN[^-\n]{0,100}-----[A-Za-z0-9+/=\r\n. ]{0,65536}-----END[^-\n]{0,100}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_.-]{20,300}/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:\/\s]+:[^\@\/\s]+@[^\s\/]+/gi,
  /https?:\/\/[^\s:\/]+:[^\s@\/]+@[^\s\/]+/gi,
  /\b(?:AC|SK)[a-f0-9]{32}\b/g,
  /(?:[?&])(?:sig|se|sp|srt|ss|sv|st)=[A-Za-z0-9%_-]+/gi,
  /\b(?:vercel_|heroku_|dd_|pk_)[A-Za-z0-9_-]{20,}\b/gi,
  /aws_secret_access_key(?:[ \t]*[=:][ \t]*|[ \t]+)(?:\\"[A-Za-z0-9/+]{40}\\"|"[A-Za-z0-9/+]{40}"|'[A-Za-z0-9/+]{40}'|[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))/gi,
];

// No regex can say where a shell word ends, so a regex only finds where a secret argument starts
// and a scanner reads its value, in the quote the text is in at that point.

/** The bash quote at a position. A `#` comment reads like a quote that the line break closes. */
type Quote = 'none' | 'double' | 'single' | 'ansi' | 'comment';

const BACKSLASH = 0x5c;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const DOLLAR = 0x24;
const HASH = 0x23;
const LF = 0x0a;
const CR = 0x0d;
const EOF = -1;
const CLOSE = -2;
const PLAIN = -3;
const MAX_QUOTED_PART = 4096;

const charTable = (chars: string): Uint8Array =>
  Uint8Array.from({ length: 128 }, (_, c) => (chars.includes(String.fromCharCode(c)) ? 1 : 0));

const OPERATORS = ';|&()<>`';
const OPERATOR = charTable(OPERATORS);
const SPECIAL = charTable(`\t\n\v\f\r ${OPERATORS}"'\\$`);

const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);
const isOperator = (c: number): boolean => c >= 0 && c < 128 && OPERATOR[c] === 1;
const isBlankOrOperator = (c: number): boolean => isSpace(c) || isOperator(c);

/** The first `end` characters of `text`, without the word the cut splits, whose first part no
 * pattern may match. */
export function cutAtWord(text: string, end: number): string {
  let start = end;
  if (!isSpace(text.charCodeAt(end))) {
    while (start > 0 && !isSpace(text.charCodeAt(start - 1))) start--;
  }
  return text.slice(0, start);
}

function skipPlain(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 128 && SPECIAL[c] === 1) break;
    i++;
  }
  return i;
}

// Inside a double-quoted string, such as JSON, the command is escaped: \" is a quote, \\ a
// backslash and \n \r \t whitespace. An unescaped " there is CLOSE, the end of the string.
function unitAt(text: string, i: number, context: Quote): number {
  if (i >= text.length) return EOF;
  const c = text.charCodeAt(i);
  if (context === 'double') {
    if (c === DOUBLE_QUOTE) return CLOSE;
    if (c !== BACKSLASH || i + 1 >= text.length) return c;
    const escaped = text.charCodeAt(i + 1);
    if (escaped === DOUBLE_QUOTE || escaped === BACKSLASH) return escaped;
    if (escaped === 0x6e) return LF;
    if (escaped === 0x72) return CR;
    return escaped === 0x74 ? 0x09 : PLAIN;
  }
  if (context === 'comment') return c === LF ? CLOSE : c;
  return c === SINGLE_QUOTE && context !== 'none' ? CLOSE : c;
}

function unitLength(text: string, i: number, context: Quote): number {
  return context === 'double' && text.charCodeAt(i) === BACKSLASH && i + 1 < text.length ? 2 : 1;
}

// Where the shell word at `from` ends. Started `inside` a quote, it returns where that quote closes.
function readValue(text: string, from: number, context: Quote, inside: Quote = 'none'): number {
  let i = from;
  let part = inside;
  let opened = from - 1;
  let dollar = false;
  for (;;) {
    const plain = skipPlain(text, i);
    if (plain > i) {
      i = plain;
      dollar = false;
    }
    const c = unitAt(text, i, context);
    if (part !== 'none') {
      if (c === EOF || c === CLOSE) return bareWord(text, from, context);
      if (i - opened - 1 > MAX_QUOTED_PART) return plainPrefix(text, from);
    } else if (c === EOF || c === CLOSE || isBlankOrOperator(c)) {
      return i;
    }
    const at = i;
    i += unitLength(text, i, context);
    if (c === BACKSLASH && part !== 'single') {
      i = afterEscaped(text, i, context);
    } else if (part === 'none' && (c === DOUBLE_QUOTE || c === SINGLE_QUOTE)) {
      part = c === DOUBLE_QUOTE ? 'double' : dollar ? 'ansi' : 'single';
      opened = at;
    } else if (part !== 'none' && c === (part === 'double' ? DOUBLE_QUOTE : SINGLE_QUOTE)) {
      if (inside !== 'none') return at;
      part = 'none';
    }
    dollar = c === DOLLAR;
  }
}

function afterEscaped(text: string, from: number, context: Quote): number {
  const escaped = unitAt(text, from, context);
  if (escaped === EOF || escaped === CLOSE) return from;
  const i = from + unitLength(text, from, context);
  return escaped === CR && unitAt(text, i, context) === LF ? i + unitLength(text, i, context) : i;
}

function bareWord(text: string, from: number, context: Quote): number {
  let i = from;
  for (;;) {
    i = skipPlain(text, i);
    const c = unitAt(text, i, context);
    if (c === EOF || c === CLOSE || isBlankOrOperator(c)) return i;
    i += unitLength(text, i, context);
    if (c === BACKSLASH) i = afterEscaped(text, i, context);
  }
}

// Free text with an odd apostrophe, or a heredoc body, reads as an open quote. A value that reaches
// that quote still takes each quoted run of plain characters after it, and the word that follows,
// as in `'hunter2'`, `-p'hunter2'` or `'hunter'"2"`.
function valueEnd(text: string, from: number, quote: Quote): number {
  let end = readValue(text, from, quote);
  for (let run = quotedRun(text, end, quote); run > end; run = quotedRun(text, end, quote)) {
    end = readValue(text, run, quote);
  }
  return end;
}

function quotedRun(text: string, from: number, quote: Quote): number {
  const end = skipPlain(text, from + 1);
  const run =
    quote !== 'comment' && unitAt(text, from, quote) === CLOSE && text[end] === text[from];
  return run ? end + 1 : from;
}

// A long quoted part may still close later, so the value stops before any quote or backslash, and
// removing it cannot change how bash or classifyBash() quote the rest.
function plainPrefix(text: string, from: number): number {
  let i = skipPlain(text, from);
  while (text.charCodeAt(i) === DOLLAR) i = skipPlain(text, i + 1);
  return i;
}

class QuoteTracker {
  private index = 0;
  private quote: Quote = 'none';
  private dollar = false;

  constructor(private readonly text: string) {}

  advanceTo(to: number): Quote {
    const { text } = this;
    let { index: i, quote, dollar } = this;
    for (; i < to; i++) {
      const c = text.charCodeAt(i);
      if (quote === 'comment') {
        if (c === LF) quote = 'none';
      } else if (quote === 'single') {
        if (c === SINGLE_QUOTE) quote = 'none';
      } else if (c === BACKSLASH) {
        i++;
      } else if (quote === 'none') {
        if (c === DOUBLE_QUOTE) quote = 'double';
        else if (c === SINGLE_QUOTE) quote = dollar ? 'ansi' : 'single';
        else if (c === HASH && (i === 0 || isBlankOrOperator(text.charCodeAt(i - 1))))
          quote = 'comment';
      } else if (c === (quote === 'double' ? DOUBLE_QUOTE : SINGLE_QUOTE)) {
        quote = 'none';
      }
      dollar = c === DOLLAR;
    }
    this.index = i;
    this.quote = quote;
    this.dollar = dollar;
    return quote;
  }

  skipRedacted(start: number, end: number): void {
    this.advanceTo(start);
    this.index = Math.max(this.index, end);
    this.dollar = false;
  }
}

/** Appends start and end pairs to redact, in order, and returns where the next search starts. */
type Redact = (text: string, match: RegExpExecArray, quote: Quote, spans: number[]) => number;

interface ArgumentRule {
  // Starts with a literal: a leading lookbehind runs at every position and tripled the cost of
  // a plain 1 MB command.
  readonly start: RegExp;
  readonly redact: Redact;
}

function pushValue(spans: number[], spanStart: number, from: number, end: number): number {
  if (end > from) spans.push(spanStart, end);
  return end;
}

// -H may take its header straight after the flag when the header is quoted (-H"Authorization: …").
const HEADER = new RegExp(
  String.raw`((?:-H|--header)(?:(?:[\s=]|${CONTINUATION}){1,8}|(?=\\?["']))(\\"|"|')?)(?:(?:x-)?(?:api-?key|auth-token|access-token)(?:[ \t]{0,4}:[ \t]{0,4}|[ \t]{1,4})|authorization[ \t]{0,4}:[ \t]{0,4}basic[ \t]{1,4})`,
  'gi',
);

// A header's value runs to its closing quote, which stays. In plain bash \" opens no quote.
const headerValue: Redact = (text, match, quote, spans) => {
  const from = match.index + match[0].length;
  const opener: string | undefined = match[2];
  const double = opener === '"' || (opener === '\\"' && quote === 'double');
  const end = readValue(text, from, quote, opener === "'" ? 'single' : double ? 'double' : 'none');
  return pushValue(spans, match.index + match[1].length, from, end);
};

// An = or : takes the next word even after a space or a line break, as the earlier rule did,
// because free text such as PASSWORD = "x" in a config file looks the same as an empty value.
const NAME = /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-z])\s*[=:]\s*/gi;

// --password-file and --token-stdin name where the secret is, so the flag must end in a name.
const FLAG = new RegExp(
  String.raw`-(?<=(?:^|[^\w-]|${AFTER_ESCAPE})-)-?(?:[a-z0-9]+[-_])*(?:token|password|passwd|secret|(?:api|access|secret|private)[-_]?key)(?:=[ \t]*|(?:[ \t]|${CONTINUATION})+(?![ \t-]|${CONTINUATION}))`,
  'gi',
);

const wordValue: Redact = (text, match, quote, spans) => {
  const from = match.index + match[0].length;
  return pushValue(spans, match.index, from, valueEnd(text, from, quote));
};

const QUOTING = charTable(`"'\\$`);

// The value hides at least the word after NAME= up to an operator, as the earlier \S+ rule did.
// Past where the shell word ends it keeps each quote, backslash and $, so the rest of the command
// is still read in the same quote.
const nameValue: Redact = (text, match, quote, spans) => {
  let [start, floor] = [match.index, match.index + match[0].length];
  let end = valueEnd(text, floor, quote);
  let i = end;
  for (; i < text.length && !isBlankOrOperator(text.charCodeAt(i)); i++) {
    if (QUOTING[text.charCodeAt(i)] !== 1) end = i + 1;
    else {
      pushValue(spans, start, floor, end);
      start = end = floor = i + 1;
    }
  }
  pushValue(spans, start, floor, end);
  return i;
};

const MYSQL = /(?:mysql(?:dump|admin)?|mariadb)\b/g;
const ESCAPED_P = new RegExp(String.raw`(?<=${AFTER_ESCAPE})-p`, 'y');
const PORT_MAPPING = /[\d.]+:\d/y;
const REDIRECT = /&>>?|[<>][<>&|]*/y;
const ONLY_CONTINUATION = new RegExp(String.raw`^${CONTINUATION}$`);

// A command name starts a word, possibly right after an escape that ends in a letter (\ncurl).
const WORD_START = new RegExp(String.raw`(?<!\w)|(?<=${AFTER_ESCAPE})`, 'y');

function startsWord(text: string, index: number): boolean {
  WORD_START.lastIndex = index;
  return WORD_START.test(text);
}

// When the match starts a word, visits each word after it up to the end of its command, and returns
// that end. A redirection such as 2>&1 does not end the command, and a JSON-escaped line break only separates
// words.
function commandWords(
  text: string,
  match: RegExpExecArray,
  quote: Quote,
  visit: (from: number, end: number) => void,
): number {
  let i = match.index + match[0].length;
  if (!startsWord(text, match.index)) return i;
  for (;;) {
    while (isSpace(unitAt(text, i, quote)) && text.charCodeAt(i) !== LF) {
      i += unitLength(text, i, quote);
    }
    REDIRECT.lastIndex = i;
    if ('<>&'.includes(text[i]) && REDIRECT.test(text)) {
      i = REDIRECT.lastIndex;
      continue;
    }
    const end = valueEnd(text, i, quote);
    if (end === i) return i;
    if (!ONLY_CONTINUATION.test(text.slice(i, end))) visit(i, end);
    i = end;
  }
}

// -p is a port, parents or preserve flag elsewhere, so only a mysql client's -p<value> words count,
// unless the value maps a port (-p3306:3306).
const mysqlPasswords: Redact = (text, match, quote, spans) =>
  commandWords(text, match, quote, (from, end) => {
    const flag = passwordFlag(text, from, end);
    if (flag >= 0) spans.push(flag, end);
  });

function passwordFlag(text: string, from: number, end: number): number {
  for (let flag = from; flag + 2 < end; flag++) {
    if (text.charCodeAt(flag) !== 0x2d || text.charCodeAt(flag + 1) !== 0x70) continue;
    ESCAPED_P.lastIndex = flag;
    if (flag > from && !ESCAPED_P.test(text)) continue;
    PORT_MAPPING.lastIndex = flag + 2;
    return PORT_MAPPING.test(text) ? -1 : flag;
  }
  return -1;
}

const CURL = /curl\b/g;
// curl's long options that take a value (`curl --help all`, curl 8.7). The value is the next word,
// or the rest of the word after `=`, even when it starts with a dash.
const CURL_LONG_TAKES_VALUE: ReadonlySet<string> = new Set(
  `
  --abstract-unix-socket --alt-svc --aws-sigv4 --cacert --capath --cert --cert-type --ciphers
  --config --connect-timeout --connect-to --continue-at --cookie --cookie-jar --create-file-mode
  --crlfile --curves --data --data-ascii --data-binary --data-raw --data-urlencode --delegation
  --dns-interface --dns-ipv4-addr --dns-ipv6-addr --dns-servers --doh-url --dump-header --egd-file
  --engine --etag-compare --etag-save --expect100-timeout --form --form-string --ftp-account
  --ftp-alternative-to-user --ftp-method --ftp-port --ftp-ssl-ccc-mode --happy-eyeballs-timeout-ms
  --haproxy-clientip --header --help --hostpubmd5 --hostpubsha256 --hsts --interface --ipfs-gateway
  --json --keepalive-time --key --key-type --krb --libcurl --limit-rate --local-port
  --login-options --mail-auth --mail-from --mail-rcpt --max-filesize --max-redirs --max-time
  --netrc-file --noproxy --oauth2-bearer --output --output-dir --parallel-max --pass --pinnedpubkey
  --preproxy --proto --proto-default --proto-redir --proxy --proxy1.0 --proxy-cacert
  --proxy-capath --proxy-cert --proxy-cert-type --proxy-ciphers --proxy-crlfile --proxy-header
  --proxy-key --proxy-key-type --proxy-pass --proxy-pinnedpubkey --proxy-service-name
  --proxy-tls13-ciphers --proxy-tlsauthtype --proxy-tlspassword --proxy-tlsuser --proxy-user
  --pubkey --quote --random-file --range --rate --referer --request --request-target --resolve
  --retry --retry-delay --retry-max-time --sasl-authzid --service-name --socks4 --socks4a --socks5
  --socks5-gssapi-service --socks5-hostname --speed-limit --speed-time --stderr --telnet-option
  --tftp-blksize --time-cond --tls-max --tls13-ciphers --tlsauthtype --tlspassword --tlsuser
  --trace --trace-ascii --trace-config --unix-socket --upload-file --url --url-query --user
  --user-agent --variable --write-out
  `
    .trim()
    .split(/\s+/),
);
// The long options whose value is a secret, redacted like -u.
const CURL_LONG_CREDENTIAL: ReadonlySet<string> = new Set([
  '--cookie',
  '--oauth2-bearer',
  '--pass',
  '--proxy-pass',
  '--proxy-tlspassword',
  '--proxy-user',
  '--tlspassword',
  '--user',
]);
// curl's short options that take a value. The value is the rest of the word, or the next word.
const CURL_TAKES_VALUE = charTable('AbcCdDeEFHKmoPQrtTuUwxXyYz');
// -b takes cookie data or a cookie file's name. Telling them apart needs the file system, so both
// are redacted.
const CURL_CREDENTIAL = charTable('btuU');
// A word such as -"u" ends in a closing quote, so its value is the next word.
const ONLY_QUOTES = /^(?:\\*["'])*$/;

// A long option's name as curl receives it: the quotes and backslashes that bash removes are gone.
function curlLongName(word: string): string {
  const equals = word.indexOf('=');
  return (equals < 0 ? word : word.slice(0, equals)).replace(/["'\\]/g, '');
}

// The values of -u, -U, -b, -t and the long credential options are redacted, in the same word
// (-uuser:pw, -sSu user:pw, --user=user:pw) or the next. Another option's value, as in -o -t.txt,
// is skipped.
const curlCredentials: Redact = (text, match, quote, spans) => {
  let pending: { start: number; credential: boolean } | undefined;
  return commandWords(text, match, quote, (from, end) => {
    if (pending !== undefined) {
      if (pending.credential) spans.push(pending.start, end);
      pending = undefined;
      return;
    }
    const word = text.slice(from, end);
    const name = curlLongName(word);
    if (name.startsWith('--')) {
      const credential = CURL_LONG_CREDENTIAL.has(name);
      if (word.includes('=')) {
        if (credential) spans.push(from, end);
      } else if (credential || CURL_LONG_TAKES_VALUE.has(name)) {
        pending = { start: from, credential };
      }
      return;
    }
    if (word[0] !== '-') return;
    for (let k = 1; k < word.length; k++) {
      const c = word.charCodeAt(k);
      if (c >= 128 || CURL_TAKES_VALUE[c] !== 1) continue;
      const start = k === 1 ? from : from + k;
      const credential = CURL_CREDENTIAL[c] === 1;
      if (!ONLY_QUOTES.test(word.slice(k + 1))) {
        if (credential) spans.push(start, end);
      } else pending = { start, credential };
      return;
    }
  });
};

interface PasswordOption {
  readonly flags: readonly string[];
  // The value may also share the flag's word (-phunter2, -p=hunter2).
  readonly joined: boolean;
  // Options end at the first operand, the command the tool wraps, and these options take the next
  // word as their value.
  readonly wrapperOptions?: readonly string[];
}

// The password is the word after the flag, unless that word is the next option.
const passwordValue =
  ({ flags, joined, wrapperOptions }: PasswordOption): Redact =>
  (text, match, quote, spans) => {
    let pending = -1;
    let skipNext = false;
    let wrapped = false;
    return commandWords(text, match, quote, (from, end) => {
      const word = text.slice(from, end);
      if (pending >= 0 && word[0] !== '-') spans.push(pending, end);
      else if (wrapped || skipNext) skipNext = false;
      else if (flags.includes(word)) pending = from;
      else if (joined && flags.some((flag) => word.startsWith(flag))) spans.push(from, end);
      else if (wrapperOptions !== undefined) {
        wrapped = word[0] !== '-';
        skipNext = wrapperOptions.includes(word);
      }
      if (pending !== from) pending = -1;
    });
  };

type RedactionRule = RegExp | ArgumentRule;

const RULES: readonly RedactionRule[] = [
  { start: HEADER, redact: headerValue },
  { start: NAME, redact: nameValue },
  ...REDACTION_PATTERNS,
  { start: FLAG, redact: wordValue },
  { start: MYSQL, redact: mysqlPasswords },
  { start: CURL, redact: curlCredentials },
  { start: /docker[ \t]+login\b/g, redact: passwordValue({ flags: ['-p'], joined: true }) },
  {
    start: /sshpass\b/g,
    redact: passwordValue({ flags: ['-p'], joined: true, wrapperOptions: ['-f', '-d', '-P'] }),
  },
  { start: /redis-cli\b/g, redact: passwordValue({ flags: ['-a', '--pass'], joined: false }) },
];

/** Whether a match starting at `index` counts. A match that does not resumes one character later. */
export type MatchFilter = (text: string, index: number) => boolean;

export function redactSecrets(text: string, counts?: MatchFilter): string {
  let result = text;
  for (const rule of RULES) result = applyRule(result, rule, counts);
  return result;
}

function applyRule(text: string, rule: RedactionRule, counts?: MatchFilter): string {
  if (rule instanceof RegExp && counts === undefined) return text.replace(rule, '[REDACTED]');
  const pattern = rule instanceof RegExp ? rule : rule.start;
  const quotes = rule instanceof RegExp ? undefined : new QuoteTracker(text);
  const spans: number[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (counts !== undefined && !counts(text, match.index)) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    const first = spans.length;
    let resume = pattern.lastIndex;
    if (quotes === undefined || rule instanceof RegExp) spans.push(match.index, resume);
    else resume = rule.redact(text, match, quotes.advanceTo(match.index), spans);
    for (let k = first; k < spans.length; k += 2) quotes?.skipRedacted(spans[k], spans[k + 1]);
    pattern.lastIndex = resume;
  }
  if (spans.length === 0) return text;
  const kept = [text.slice(0, spans[0])];
  for (let k = 1; k < spans.length; k += 2) kept.push(text.slice(spans[k], spans[k + 1]));
  return kept.join('[REDACTED]');
}
