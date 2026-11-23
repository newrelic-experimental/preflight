#!/usr/bin/env node

// src/hooks/collector-script.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, existsSync, utimesSync } from "node:fs";
import { resolve as resolve3, dirname as dirname3 } from "node:path";
import { homedir } from "node:os";
import { createHash as createHash2 } from "node:crypto";

// src/redaction-patterns.ts
var AFTER_ESCAPE = String.raw`\\[nrtbf]|\\u[0-9a-fA-F]{4}|(?:\x1b|\\u001[bB])\[[0-9;]{0,20}m|%[0-9a-fA-F]{2}`;
var CONTINUATION = String.raw`(?:\\\r?\n|\\\\\\n)`;
var REDACTION_PATTERNS = [
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
  /aws_secret_access_key(?:[ \t]*[=:][ \t]*|[ \t]+)(?:\\"[A-Za-z0-9/+]{40}\\"|"[A-Za-z0-9/+]{40}"|'[A-Za-z0-9/+]{40}'|[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))/gi
];
var BACKSLASH = 92;
var DOUBLE_QUOTE = 34;
var SINGLE_QUOTE = 39;
var DOLLAR = 36;
var HASH = 35;
var LF = 10;
var CR = 13;
var EOF = -1;
var CLOSE = -2;
var PLAIN = -3;
var MAX_QUOTED_PART = 4096;
var charTable = (chars) => Uint8Array.from({ length: 128 }, (_, c) => chars.includes(String.fromCharCode(c)) ? 1 : 0);
var OPERATORS = ";|&()<>`";
var OPERATOR = charTable(OPERATORS);
var SPECIAL = charTable(`	
\v\f\r ${OPERATORS}"'\\$`);
var isSpace = (c) => c === 32 || c >= 9 && c <= 13;
var isOperator = (c) => c >= 0 && c < 128 && OPERATOR[c] === 1;
var isBlankOrOperator = (c) => isSpace(c) || isOperator(c);
function cutAtWord(text, end) {
  let start = end;
  if (!isSpace(text.charCodeAt(end))) {
    while (start > 0 && !isSpace(text.charCodeAt(start - 1))) start--;
  }
  return text.slice(0, start);
}
function skipPlain(text, from) {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 128 && SPECIAL[c] === 1) break;
    i++;
  }
  return i;
}
function unitAt(text, i, context) {
  if (i >= text.length) return EOF;
  const c = text.charCodeAt(i);
  if (context === "double") {
    if (c === DOUBLE_QUOTE) return CLOSE;
    if (c !== BACKSLASH || i + 1 >= text.length) return c;
    const escaped = text.charCodeAt(i + 1);
    if (escaped === DOUBLE_QUOTE || escaped === BACKSLASH) return escaped;
    if (escaped === 110) return LF;
    if (escaped === 114) return CR;
    return escaped === 116 ? 9 : PLAIN;
  }
  if (context === "comment") return c === LF ? CLOSE : c;
  return c === SINGLE_QUOTE && context !== "none" ? CLOSE : c;
}
function unitLength(text, i, context) {
  return context === "double" && text.charCodeAt(i) === BACKSLASH && i + 1 < text.length ? 2 : 1;
}
function readValue(text, from, context, inside = "none") {
  let i = from;
  let part = inside;
  let opened = from - 1;
  let dollar = false;
  for (; ; ) {
    const plain = skipPlain(text, i);
    if (plain > i) {
      i = plain;
      dollar = false;
    }
    const c = unitAt(text, i, context);
    if (part !== "none") {
      if (c === EOF || c === CLOSE) return bareWord(text, from, context);
      if (i - opened - 1 > MAX_QUOTED_PART) return plainPrefix(text, from);
    } else if (c === EOF || c === CLOSE || isBlankOrOperator(c)) {
      return i;
    }
    const at = i;
    i += unitLength(text, i, context);
    if (c === BACKSLASH && part !== "single") {
      i = afterEscaped(text, i, context);
    } else if (part === "none" && (c === DOUBLE_QUOTE || c === SINGLE_QUOTE)) {
      part = c === DOUBLE_QUOTE ? "double" : dollar ? "ansi" : "single";
      opened = at;
    } else if (part !== "none" && c === (part === "double" ? DOUBLE_QUOTE : SINGLE_QUOTE)) {
      if (inside !== "none") return at;
      part = "none";
    }
    dollar = c === DOLLAR;
  }
}
function afterEscaped(text, from, context) {
  const escaped = unitAt(text, from, context);
  if (escaped === EOF || escaped === CLOSE) return from;
  const i = from + unitLength(text, from, context);
  return escaped === CR && unitAt(text, i, context) === LF ? i + unitLength(text, i, context) : i;
}
function bareWord(text, from, context) {
  let i = from;
  for (; ; ) {
    i = skipPlain(text, i);
    const c = unitAt(text, i, context);
    if (c === EOF || c === CLOSE || isBlankOrOperator(c)) return i;
    i += unitLength(text, i, context);
    if (c === BACKSLASH) i = afterEscaped(text, i, context);
  }
}
function valueEnd(text, from, quote) {
  let end = readValue(text, from, quote);
  for (let run = quotedRun(text, end, quote); run > end; run = quotedRun(text, end, quote)) {
    end = readValue(text, run, quote);
  }
  return end;
}
function quotedRun(text, from, quote) {
  const end = skipPlain(text, from + 1);
  const run = quote !== "comment" && unitAt(text, from, quote) === CLOSE && text[end] === text[from];
  return run ? end + 1 : from;
}
function plainPrefix(text, from) {
  let i = skipPlain(text, from);
  while (text.charCodeAt(i) === DOLLAR) i = skipPlain(text, i + 1);
  return i;
}
var QuoteTracker = class {
  constructor(text) {
    this.text = text;
  }
  text;
  index = 0;
  quote = "none";
  dollar = false;
  advanceTo(to) {
    const { text } = this;
    let { index: i, quote, dollar } = this;
    for (; i < to; i++) {
      const c = text.charCodeAt(i);
      if (quote === "comment") {
        if (c === LF) quote = "none";
      } else if (quote === "single") {
        if (c === SINGLE_QUOTE) quote = "none";
      } else if (c === BACKSLASH) {
        i++;
      } else if (quote === "none") {
        if (c === DOUBLE_QUOTE) quote = "double";
        else if (c === SINGLE_QUOTE) quote = dollar ? "ansi" : "single";
        else if (c === HASH && (i === 0 || isBlankOrOperator(text.charCodeAt(i - 1))))
          quote = "comment";
      } else if (c === (quote === "double" ? DOUBLE_QUOTE : SINGLE_QUOTE)) {
        quote = "none";
      }
      dollar = c === DOLLAR;
    }
    this.index = i;
    this.quote = quote;
    this.dollar = dollar;
    return quote;
  }
  skipRedacted(start, end) {
    this.advanceTo(start);
    this.index = Math.max(this.index, end);
    this.dollar = false;
  }
};
function pushValue(spans, spanStart, from, end) {
  if (end > from) spans.push(spanStart, end);
  return end;
}
var HEADER = new RegExp(
  String.raw`((?:-H|--header)(?:[\s=]|${CONTINUATION}){1,8}(\\"|"|')?)(?:(?:x-)?(?:api-?key|auth-token|access-token)(?:[ \t]{0,4}:[ \t]{0,4}|[ \t]{1,4})|authorization[ \t]{0,4}:[ \t]{0,4}basic[ \t]{1,4})`,
  "gi"
);
var headerValue = (text, match, quote, spans) => {
  const from = match.index + match[0].length;
  const opener = match[2];
  const double = opener === '"' || opener === '\\"' && quote === "double";
  const end = readValue(text, from, quote, opener === "'" ? "single" : double ? "double" : "none");
  return pushValue(spans, match.index + match[1].length, from, end);
};
var NAME = /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-z])\s*[=:]\s*/gi;
var FLAG = new RegExp(
  String.raw`-(?<=(?:^|[^\w-]|${AFTER_ESCAPE})-)-?(?:[a-z0-9]+[-_])*(?:token|password|passwd|secret|(?:api|access|secret|private)[-_]?key)(?:=[ \t]*|(?:[ \t]|${CONTINUATION})+(?![ \t-]|${CONTINUATION}))`,
  "gi"
);
var wordValue = (text, match, quote, spans) => {
  const from = match.index + match[0].length;
  return pushValue(spans, match.index, from, valueEnd(text, from, quote));
};
var QUOTING = charTable(`"'\\$`);
var nameValue = (text, match, quote, spans) => {
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
var MYSQL = /(?:mysql(?:dump|admin)?|mariadb)\b/g;
var ESCAPED_P = new RegExp(String.raw`(?<=${AFTER_ESCAPE})-p`, "y");
var PORT_MAPPING = /[\d.]+:\d/y;
var REDIRECT = /&>>?|[<>][<>&|]*/y;
var ONLY_CONTINUATION = new RegExp(String.raw`^${CONTINUATION}$`);
var WORD_START = new RegExp(String.raw`(?<!\w)|(?<=${AFTER_ESCAPE})`, "y");
function startsWord(text, index) {
  WORD_START.lastIndex = index;
  return WORD_START.test(text);
}
function commandWords(text, match, quote, visit) {
  let i = match.index + match[0].length;
  if (!startsWord(text, match.index)) return i;
  for (; ; ) {
    while (isSpace(unitAt(text, i, quote)) && text.charCodeAt(i) !== LF) {
      i += unitLength(text, i, quote);
    }
    REDIRECT.lastIndex = i;
    if ("<>&".includes(text[i]) && REDIRECT.test(text)) {
      i = REDIRECT.lastIndex;
      continue;
    }
    const end = valueEnd(text, i, quote);
    if (end === i) return i;
    if (!ONLY_CONTINUATION.test(text.slice(i, end))) visit(i, end);
    i = end;
  }
}
var mysqlPasswords = (text, match, quote, spans) => commandWords(text, match, quote, (from, end) => {
  const flag = passwordFlag(text, from, end);
  if (flag >= 0) spans.push(flag, end);
});
function passwordFlag(text, from, end) {
  for (let flag = from; flag + 2 < end; flag++) {
    if (text.charCodeAt(flag) !== 45 || text.charCodeAt(flag + 1) !== 112) continue;
    ESCAPED_P.lastIndex = flag;
    if (flag > from && !ESCAPED_P.test(text)) continue;
    PORT_MAPPING.lastIndex = flag + 2;
    return PORT_MAPPING.test(text) ? -1 : flag;
  }
  return -1;
}
var CURL = /curl\b/g;
var CURL_LONG_CREDENTIAL = /--(?:proxy-)?user(?:=|$)/y;
var CURL_TAKES_VALUE = charTable("AbcCdDeEFHKmoPQrtTuUwxXyYz");
var CURL_CREDENTIAL = charTable("tuU");
var ONLY_QUOTES = /^(?:\\*["'])*$/;
var curlCredentials = (text, match, quote, spans) => {
  let pending;
  return commandWords(text, match, quote, (from, end) => {
    if (pending !== void 0) {
      if (pending.credential) spans.push(pending.start, end);
      pending = void 0;
      return;
    }
    const word = text.slice(from, end);
    CURL_LONG_CREDENTIAL.lastIndex = 0;
    if (CURL_LONG_CREDENTIAL.test(word)) {
      if (word.includes("=")) spans.push(from, end);
      else pending = { start: from, credential: true };
      return;
    }
    if (word[0] !== "-" || word[1] === "-") return;
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
var passwordValue = ({ flags, joined, wrapperOptions }) => (text, match, quote, spans) => {
  let pending = -1;
  let skipNext = false;
  let wrapped = false;
  return commandWords(text, match, quote, (from, end) => {
    const word = text.slice(from, end);
    if (pending >= 0 && word[0] !== "-") spans.push(pending, end);
    else if (wrapped || skipNext) skipNext = false;
    else if (flags.includes(word)) pending = from;
    else if (joined && flags.some((flag) => word.startsWith(flag))) spans.push(from, end);
    else if (wrapperOptions !== void 0) {
      wrapped = word[0] !== "-";
      skipNext = wrapperOptions.includes(word);
    }
    if (pending !== from) pending = -1;
  });
};
var RULES = [
  { start: HEADER, redact: headerValue },
  { start: NAME, redact: nameValue },
  ...REDACTION_PATTERNS,
  { start: FLAG, redact: wordValue },
  { start: MYSQL, redact: mysqlPasswords },
  { start: CURL, redact: curlCredentials },
  { start: /docker[ \t]+login\b/g, redact: passwordValue({ flags: ["-p"], joined: true }) },
  {
    start: /sshpass\b/g,
    redact: passwordValue({ flags: ["-p"], joined: true, wrapperOptions: ["-f", "-d", "-P"] })
  },
  { start: /redis-cli\b/g, redact: passwordValue({ flags: ["-a", "--pass"], joined: false }) }
];
function redactSecrets(text, counts) {
  let result = text;
  for (const rule of RULES) result = applyRule(result, rule, counts);
  return result;
}
function applyRule(text, rule, counts) {
  if (rule instanceof RegExp && counts === void 0) return text.replace(rule, "[REDACTED]");
  const pattern = rule instanceof RegExp ? rule : rule.start;
  const quotes = rule instanceof RegExp ? void 0 : new QuoteTracker(text);
  const spans = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (counts !== void 0 && !counts(text, match.index)) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    const first = spans.length;
    let resume = pattern.lastIndex;
    if (quotes === void 0 || rule instanceof RegExp) spans.push(match.index, resume);
    else resume = rule.redact(text, match, quotes.advanceTo(match.index), spans);
    for (let k = first; k < spans.length; k += 2) quotes?.skipRedacted(spans[k], spans[k + 1]);
    pattern.lastIndex = resume;
  }
  if (spans.length === 0) return text;
  const kept = [text.slice(0, spans[0])];
  for (let k = 1; k < spans.length; k += 2) kept.push(text.slice(spans[k], spans[k + 1]));
  return kept.join("[REDACTED]");
}

// src/record-content-gate.ts
function resolveRecordContent(highSecurity, explicitValue) {
  return highSecurity ? false : explicitValue;
}

// src/platforms/platform-names.ts
var PLATFORM_NAMES = [
  "claude-code",
  "cursor",
  "windsurf",
  "copilot",
  "copilot-app",
  "copilot-sdk",
  "zed",
  "continue",
  "amazon-q",
  "kiro",
  "droid",
  "gemini-cli",
  "cline",
  "codex",
  "opencode",
  "kilocode",
  "pi",
  "antigravity",
  "generic-mcp"
];
var ENGINE_ENV_KEYS = ["MCP_CLIENT", "NEW_RELIC_AI_PLATFORM"];
var aliasKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
var PLATFORM_BY_ALIAS = new Map(
  PLATFORM_NAMES.map((n) => [aliasKey(n), n])
);
function canonicalPlatformName(name) {
  return name ? PLATFORM_BY_ALIAS.get(aliasKey(name)) : void 0;
}

// src/platforms/claude-code-adapter.ts
var CLAUDE_CODE_PLATFORM_NAME = "claude-code";
var CLAUDE_CODE_ENV_SIGNALS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE",
  "CLAUDE_CODE_VERSION"
];

// src/hook-subcommands.ts
var HOOK_EVENT_TYPES = [
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "StopFailure"
];
var HOOK_SUBCOMMANDS = {
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  PermissionRequest: "permission-request",
  PermissionDenied: "permission-denied",
  StopFailure: "stop-failure"
};
function hookEventFromArg(arg) {
  if (arg === void 0) return void 0;
  const lower = arg.toLowerCase();
  return HOOK_EVENT_TYPES.find(
    (event) => event.toLowerCase() === lower || HOOK_SUBCOMMANDS[event] === lower
  );
}

// src/platforms/types.ts
var UNATTRIBUTED_BREADCRUMB_WRITER = "unattributed";

// src/hooks/self-report.ts
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import { dirname, resolve } from "node:path";

// src/hooks/synthetic-session-id.ts
function isSyntheticSessionId(id) {
  if (!id) return false;
  return id.startsWith("local-") || id.startsWith("proxy-") || id.startsWith("pending-");
}

// src/hooks/self-report.ts
var REPORT_TOKENS_TOOL_NAME = "nr_observe_report_tokens";
var MAX_TOKENS = 1e7;
var REPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
var MODEL_RE = /^[a-zA-Z0-9._:-]{1,256}$/;
var SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
var REQUIRED_COUNTS = ["input_tokens", "output_tokens"];
var OPTIONAL_COUNTS = ["thinking_tokens", "cache_read_tokens", "cache_creation_tokens"];
function clampToken(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(0, Math.floor(v)), MAX_TOKENS);
}
function isPreflightServerName(name) {
  return typeof name === "string" && (/preflight/i.test(name) || name === "nr-ai-observability");
}
function reportKey(r) {
  const counts = [r.model, r.inputTokens, r.outputTokens, r.thinkingTokens, r.cacheReadTokens];
  const digest = createHash("sha256").update(JSON.stringify([...counts, r.cacheCreationTokens])).digest("hex");
  return `${r.reportId}-${digest.slice(0, 16)}`;
}
function isConversationId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id) && id !== "unknown" && !isSyntheticSessionId(id);
}
function decodeObject(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return void 0;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function parseSelfReport(args) {
  const fail = (reason) => ({ ok: false, reason });
  const a = decodeObject(args);
  if (!a) return fail("arguments are not a JSON object");
  if (typeof a.report_id !== "string" || !REPORT_ID_RE.test(a.report_id)) {
    return fail("report_id must be 8 to 128 characters of [A-Za-z0-9_-], new for every call");
  }
  if (typeof a.model !== "string" || !MODEL_RE.test(a.model)) {
    return fail("model must be 1 to 256 characters of [a-zA-Z0-9._:-]");
  }
  const counts = {};
  const readCounts = (fields, fallback) => {
    for (const field of fields) {
      const n = a[field] ?? fallback;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return field;
      counts[field] = clampToken(n);
    }
    return void 0;
  };
  const bad = readCounts(REQUIRED_COUNTS) ?? readCounts(OPTIONAL_COUNTS, 0);
  if (bad) return fail(`${bad} must be a non-negative number`);
  return {
    ok: true,
    report: {
      reportId: a.report_id,
      model: a.model,
      inputTokens: counts.input_tokens,
      outputTokens: counts.output_tokens,
      thinkingTokens: counts.thinking_tokens,
      cacheReadTokens: counts.cache_read_tokens,
      cacheCreationTokens: counts.cache_creation_tokens
    }
  };
}
function hookAcknowledged(result, reportId) {
  const value = decodeObject(result);
  if (!value || value.isError === true) return false;
  const replies = Array.isArray(value.content) ? value.content.map(
    (block) => decodeObject(block?.text)
  ) : [value];
  return replies.some(
    (reply) => reply?.accepted === true && reply.recorded_by === "hook" && reply.report_id === reportId
  );
}
function hookSelfReportLine(call, conversationId, timestamp, platform) {
  const isReport = call.tool === REPORT_TOKENS_TOOL_NAME && isPreflightServerName(call.server);
  if (!isReport || !isConversationId(conversationId)) return void 0;
  const parsed = parseSelfReport(call.args);
  if (!parsed.ok || !hookAcknowledged(call.result, parsed.report.reportId)) return void 0;
  const { report } = parsed;
  return {
    mode: "self_report",
    tool: REPORT_TOKENS_TOOL_NAME,
    timestamp,
    sessionId: conversationId,
    ...report,
    platform
  };
}
function claimPath(storageDir, line) {
  return resolve(storageDir, "self-reports", line.sessionId, reportKey(line));
}
function createClaim(path) {
  closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384));
}
var CLAIM_DIR_RETRIES = 3;
function claimReport(storageDir, line) {
  const path = claimPath(storageDir, line);
  for (let retries = 0; ; retries++) {
    try {
      createClaim(path);
      return true;
    } catch (err) {
      if (err.code !== "ENOENT" || retries === CLAIM_DIR_RETRIES) {
        return false;
      }
    }
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 448 });
    } catch {
      return false;
    }
  }
}
function releaseReport(storageDir, line) {
  try {
    unlinkSync(claimPath(storageDir, line));
  } catch {
    return;
  }
}
var SELF_REPORT_CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;

// src/hooks/session-breadcrumbs.ts
import { resolve as resolve2 } from "node:path";
var BREADCRUMBS_DIR = "breadcrumbs";
var STALE_CWD_BREADCRUMB_MS = 7 * 24 * 60 * 60 * 1e3;
function breadcrumbRoot(storagePath, writer) {
  return resolve2(storagePath, BREADCRUMBS_DIR, writer);
}
function breadcrumbWriter(env) {
  for (const key of ENGINE_ENV_KEYS) {
    const name = canonicalPlatformName(env[key]);
    if (name === "generic-mcp") return UNATTRIBUTED_BREADCRUMB_WRITER;
    if (name !== void 0) return name;
  }
  return CLAUDE_CODE_ENV_SIGNALS.some((key) => env[key] !== void 0) ? CLAUDE_CODE_PLATFORM_NAME : UNATTRIBUTED_BREADCRUMB_WRITER;
}

// src/storage/hook-buffer.ts
import {
  closeSync as closeSync2,
  constants as constants2,
  fstatSync,
  openSync as openSync2,
  readFileSync,
  readSync,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeSync
} from "node:fs";
var DRAIN_SEAL = "\0preflight-drain-seal\n";
var MAX_WRITES = 5;
var MAX_OPENS = 100;
var TORN_LINE_END = "\n";
function readRange(fd, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}
function readToEnd(fd, scratch) {
  let total = 0;
  for (let n; (n = readSync(fd, scratch, 0, scratch.length, null)) > 0; ) total += n;
  return total;
}
function offsetAfterWrite(fd) {
  const scratch = Buffer.alloc(64 * 1024);
  let after = readToEnd(fd, scratch);
  for (; ; ) {
    const size = fstatSync(fd).size;
    const more = readToEnd(fd, scratch);
    if (more === 0) return size - after;
    after += more;
  }
}
function isAt(path, file) {
  const now = statSync2(path, { bigint: true, throwIfNoEntry: false });
  return now !== void 0 && now.ino === file.ino && now.dev === file.dev;
}
var LineWrittenError = class extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
};
function landedBeforeSeal(fd, sealFloor) {
  return !readRange(fd, sealFloor, offsetAfterWrite(fd)).includes(DRAIN_SEAL);
}
function appendOnce(path, data) {
  const fd = openSync2(path, constants2.O_RDWR | constants2.O_CREAT | constants2.O_APPEND, 384);
  let landed = false;
  try {
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!isAt(path, opened)) return "moved";
      const sealFloor = Number(opened.size);
      const written = writeSync(fd, data);
      try {
        if (written < data.length) {
          writeSync(fd, TORN_LINE_END);
          return "redo";
        }
        landed = isAt(path, opened) || landedBeforeSeal(fd, sealFloor);
      } catch (err) {
        landed = written >= data.length - 1 && landedBeforeSeal(fd, sealFloor);
        throw err;
      }
      return landed ? "kept" : "redo";
    } finally {
      closeSync2(fd);
    }
  } catch (err) {
    throw landed ? new LineWrittenError(err) : err;
  }
}
function appendToHookBuffer(path, text) {
  if (text.includes("\0")) {
    throw new Error(`Hook buffer text contains NUL, which marks a drain seal: ${path}`);
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error(`Hook buffer text must be exactly one newline-terminated line: ${path}`);
  }
  const data = Buffer.from("\n" + text);
  let writes = 0;
  for (let opens = 0; opens < MAX_OPENS; opens++) {
    const landing = appendOnce(path, data);
    if (landing === "kept") return;
    if (landing === "redo" && ++writes === MAX_WRITES) break;
  }
  throw new Error(`Hook buffer write raced a drain on all attempts and was not kept: ${path}`);
}

// src/metrics/mcp-pr-tools.ts
var MCP_PR_TOOL_ACTION = {
  create_pull_request: "create",
  update_pull_request: "edit",
  merge_pull_request: "merge"
};
function bareMcpToolName(toolName) {
  const parts = toolName.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return toolName;
}
function mcpPrToolAction(toolName) {
  const bare = bareMcpToolName(toolName);
  return Object.hasOwn(MCP_PR_TOOL_ACTION, bare) ? MCP_PR_TOOL_ACTION[bare] : void 0;
}

// src/hooks/bash-classifier.ts
var GIT_COMMANDS = /* @__PURE__ */ new Set(["git", "gh", "gitk", "tig"]);
var PACKAGE_MANAGERS = /* @__PURE__ */ new Set([
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "pip",
  "pip3",
  "pipx",
  "poetry",
  "uv",
  "cargo",
  "gem",
  "bundle",
  "bundler",
  "composer",
  "brew",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "apk"
]);
var TEST_RUNNERS = /* @__PURE__ */ new Set([
  "jest",
  "vitest",
  "mocha",
  "pytest",
  "rspec",
  "phpunit",
  "tap",
  "ava",
  "cypress",
  "playwright",
  "karma",
  "tox",
  "nose",
  "nose2",
  "unittest",
  "busted",
  "ginkgo"
]);
var BUILD_TOOLS = /* @__PURE__ */ new Set([
  "tsc",
  "webpack",
  "vite",
  "rollup",
  "esbuild",
  "parcel",
  "turbo",
  "nx",
  "make",
  "gmake",
  "cmake",
  "ninja",
  "gradle",
  "gradlew",
  "mvn",
  "sbt",
  "ant",
  "rake",
  "meson",
  "bazel",
  "buck",
  "pants",
  "swc",
  "babel"
]);
var CONTAINER_TOOLS = /* @__PURE__ */ new Set([
  "docker",
  "podman",
  "docker-compose",
  "podman-compose",
  "kubectl",
  "oc",
  "helm",
  "k9s",
  "kustomize",
  "kind",
  "minikube",
  "skaffold",
  "buildah",
  "crictl"
]);
var NETWORK_TOOLS = /* @__PURE__ */ new Set([
  "curl",
  "wget",
  "http",
  "httpie",
  "xh",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
  "mosh"
]);
var FS_OPS = /* @__PURE__ */ new Set([
  "ls",
  "cat",
  "cp",
  "mv",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "find",
  "chmod",
  "chown",
  "chgrp",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "bzip2",
  "xz",
  "tree",
  "ln",
  "stat",
  "du",
  "df",
  "pwd",
  "realpath",
  "readlink",
  "basename",
  "dirname"
]);
var SEARCH_TOOLS = /* @__PURE__ */ new Set(["grep", "rg", "ag", "ack", "sed", "awk", "fzf"]);
var SCRIPT_INTERPRETERS = /* @__PURE__ */ new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "fish",
  "dash",
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "ruby",
  "perl",
  "php",
  "lua",
  "tsx",
  "ts-node"
]);
var DESTRUCTIVE_PATTERNS = [
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b)/,
  // git push --force / -f, but NOT --force-with-lease / --force-if-includes
  // (which are the recommended *safe* forms). Match the force token anywhere
  // in the invocation, not just immediately after `push`.
  /\bgit\s+push\b(?=.*\s(?:--force(?!-(?:with-lease|if-includes))\b|-f\b))/i,
  /\bgit\s+reset\s+--hard\b/i,
  // git clean only deletes with -f/--force (clean.requireForce defaults to true);
  // -n/--dry-run and bare `git clean` are safe and stay unflagged.
  /\bgit\s+clean\b(?=.*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b)/i,
  /\bfind\b.*\s-delete\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bshred\b/i,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bchmod\s+777\b/,
  />\s*\/dev\/sd[a-z]/,
  /\b(?:curl|wget)\b.*\|\s*(?:\/[^\s]*\/)?(?:ba|z|k|da|fi|tc|c)?sh\b/i,
  /\b(?:curl|wget)\b.*\|\s*(?:\/[^\s]*\/)?(?:node|python3?|perl|ruby)\b/i
];
var CLOSED_BY = {
  single: "'",
  double: '"',
  "ansi-c": "'",
  comment: "\n"
};
var ESCAPES_IN = /* @__PURE__ */ new Set(["none", "double", "ansi-c"]);
var METACHAR = /[\s;&|(]/;
var HEREDOC_OPERATOR = /(?<!<)<<(-?)[ \t]*/y;
var WORD_END = /[\s;&|()<>]/;
var LINE_CONTINUES = /(?<!\\)(?:\\\\)*\\$/;
function stateOpenedAt(command, i, atWordStart) {
  const ch = command[i];
  if (ch === "'") return "single";
  if (ch === '"') return "double";
  if (ch === "$" && command[i + 1] === "'") return "ansi-c";
  if (ch === "#" && atWordStart) return "comment";
  return "none";
}
function readHeredocWord(command, start) {
  let delimiter = "";
  let quoted = false;
  let i = start;
  while (i < command.length && !WORD_END.test(command[i])) {
    const ch = command[i];
    if (ch === "\\") {
      if (i + 1 >= command.length) return void 0;
      delimiter += command[i + 1];
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === "$" && command[i + 1] === "'") {
      const open = ch === "$" ? i + 1 : i;
      const close = command.indexOf(command[open], open + 1);
      if (close === -1) return void 0;
      delimiter += command.slice(open + 1, close);
      i = close + 1;
    } else {
      delimiter += ch;
      i++;
      continue;
    }
    quoted = true;
  }
  return i === start ? void 0 : { delimiter, quoted, end: i };
}
function heredocBodiesEnd(command, start, heredocs) {
  let i = start;
  for (const { delimiter, stripTabs, quoted } of heredocs) {
    let line = "";
    while (i < command.length) {
      const eol = command.indexOf("\n", i);
      const end = eol === -1 ? command.length : eol;
      const segment = command.slice(i, end);
      i = end + 1;
      if (!quoted && LINE_CONTINUES.test(segment)) {
        line += segment.slice(0, -1);
        continue;
      }
      line += segment;
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      line = "";
    }
  }
  return i;
}
function maskQuotedRegions(command) {
  let out = "";
  let state = "none";
  let atWordStart = true;
  const heredocs = [];
  const parens = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "\\" && ESCAPES_IN.has(state)) {
      out += state === "none" ? command.slice(i, i + 2) : "  ";
      i += 2;
      atWordStart = false;
      continue;
    }
    if (state === "none") {
      HEREDOC_OPERATOR.lastIndex = i;
      const operator = HEREDOC_OPERATOR.exec(command);
      const word = operator && readHeredocWord(command, i + operator[0].length);
      if (operator && word) {
        heredocs.push({
          delimiter: word.delimiter,
          stripTabs: operator[1] === "-",
          quoted: word.quoted
        });
        out += command.slice(i, word.end);
        i = word.end;
        atWordStart = false;
        continue;
      }
      state = stateOpenedAt(command, i, atWordStart);
      if (state === "ansi-c") {
        out += " ";
        i++;
      }
      if (state !== "none") {
        out += " ";
        i++;
        atWordStart = false;
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        parens.push("substitution");
        out += "$(";
        i += 2;
        atWordStart = true;
        continue;
      }
      if (ch === "(") parens.push("group");
      out += ch;
      i++;
      atWordStart = ch === ")" ? parens.pop() !== "substitution" : METACHAR.test(ch);
      if (ch === "\n" && heredocs.length > 0) {
        const end = heredocBodiesEnd(command, i, heredocs);
        out += command.slice(i, end);
        i = end;
        heredocs.length = 0;
      }
      continue;
    }
    if (ch === CLOSED_BY[state]) {
      if (state !== "comment") {
        out += " ";
        i++;
      }
      state = "none";
      continue;
    }
    out += " ";
    i++;
  }
  return out;
}
var SUDO_VALUE_SHORT_FLAG = /^-[ughpUtCr]$/;
var SUDO_VALUE_LONG_FLAGS = /* @__PURE__ */ new Set([
  "--user",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--other-user",
  "--close-from"
]);
var SEGMENT_SPLIT_RE = /\|\||&&|;|\|/;
var SCRIPT_EXT_RE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx|rb|pl|php|lua)$/i;
function tokenize(command) {
  return command.split(/\s+/).filter((t) => t.length > 0);
}
function stripEnvTokens(tokens) {
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) {
    tokens.shift();
  }
}
function stripSudoTokens(tokens) {
  while (tokens.length > 0 && tokens[0] === "sudo") {
    tokens.shift();
    while (tokens.length > 0) {
      const flag = tokens[0] ?? "";
      if (!flag.startsWith("-")) break;
      tokens.shift();
      const next = tokens[0];
      if (next === void 0 || next.startsWith("-")) continue;
      if (SUDO_VALUE_SHORT_FLAG.test(flag) || SUDO_VALUE_LONG_FLAGS.has(flag)) {
        tokens.shift();
      }
    }
  }
}
function firstSegment(command) {
  const idx = command.search(SEGMENT_SPLIT_RE);
  return idx >= 0 ? command.slice(0, idx).trim() : command;
}
function refinePackageManager(leading, tokens) {
  const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (rest.length === 0) return "package-manager";
  let verbIdx = 0;
  if (rest[0] === "run" || rest[0] === "run-script") {
    if (rest.length < 2) return "package-manager";
    verbIdx = 1;
  }
  const verb = rest[verbIdx]?.toLowerCase();
  if (verb === void 0) return "package-manager";
  if (verb === "test" || verb === "tests" || verb === "t") return "test-runner";
  if (verb === "build" || verb === "compile") return "build";
  if (verb === "lint" || verb === "typecheck" || verb === "tsc") return "build";
  if (leading === "cargo" && verb === "test") return "test-runner";
  if (leading === "cargo" && verb === "build") return "build";
  if (leading === "go" && verb === "test") return "test-runner";
  if (leading === "go" && verb === "build") return "build";
  return "package-manager";
}
function classifyLeading(leading, tokens) {
  if (leading.length === 0) return "shell-other";
  if (GIT_COMMANDS.has(leading)) return "git";
  if (TEST_RUNNERS.has(leading)) return "test-runner";
  if (BUILD_TOOLS.has(leading)) return "build";
  if (CONTAINER_TOOLS.has(leading)) return "container";
  if (NETWORK_TOOLS.has(leading)) return "network";
  if (SEARCH_TOOLS.has(leading)) return "search";
  if (FS_OPS.has(leading)) return "fs-op";
  if (PACKAGE_MANAGERS.has(leading)) return refinePackageManager(leading, tokens);
  if ((leading === "go" || leading === "cargo") && tokens.length >= 2) {
    return refinePackageManager(leading, tokens);
  }
  if (leading === "npx" || leading === "pnpx" || leading === "bunx") {
    const next = tokens[1]?.toLowerCase();
    if (next !== void 0) {
      if (TEST_RUNNERS.has(next)) return "test-runner";
      if (BUILD_TOOLS.has(next)) return "build";
    }
    return "package-manager";
  }
  if (SCRIPT_INTERPRETERS.has(leading)) return "custom-script";
  return "shell-other";
}
function classifyBash(command) {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { category: "shell-other", leading: "", isDestructive: false, isNetwork: false };
  }
  const masked = maskQuotedRegions(trimmed);
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(masked));
  const segment = firstSegment(trimmed);
  const tokens = tokenize(segment);
  stripEnvTokens(tokens);
  stripSudoTokens(tokens);
  stripEnvTokens(tokens);
  if (tokens.length === 0) {
    return { category: "shell-other", leading: "", isDestructive, isNetwork: false };
  }
  const leadingRaw = tokens[0] ?? "";
  const explicitScriptPath = leadingRaw.startsWith("./") || leadingRaw.startsWith("../") || SCRIPT_EXT_RE.test(leadingRaw);
  const absolutePath = leadingRaw.startsWith("/");
  const leading = explicitScriptPath ? leadingRaw : leadingRaw.split("/").pop() ?? leadingRaw;
  let category = classifyLeading(leading.toLowerCase(), tokens);
  if (category === "shell-other" && (explicitScriptPath || absolutePath)) {
    category = "custom-script";
  }
  const isNetwork = category === "network" || NETWORK_TOOLS.has(leading.toLowerCase());
  return { category, leading, isDestructive, isNetwork };
}

// src/metrics/pr-ref.ts
var PR_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
function parsePrRepo(value) {
  return typeof value === "string" && PR_REPO_RE.test(value) ? value.toLowerCase() : void 0;
}

// src/hooks/minted-tool-use-ids.ts
import { randomUUID } from "node:crypto";
import {
  closeSync as closeSync3,
  mkdirSync as mkdirSync2,
  openSync as openSync3,
  readdirSync as readdirSync2,
  renameSync,
  unlinkSync as unlinkSync3,
  writeFileSync
} from "node:fs";
import { basename, dirname as dirname2, join } from "node:path";
var MINTED_IDS_DIR_PREFIX = "minted-ids-";
var MINTED_ID_PREFIX = "minted-";
var CLAIM_SUFFIX = ".claimed";
var OPEN_ENTRY_TTL_MS = 40 * 6e4;
var MAX_LISTINGS = 5;
function mintedIdsDir(bufferPath) {
  return join(dirname2(bufferPath), MINTED_IDS_DIR_PREFIX + basename(bufferPath, ".jsonl"));
}
function toolKey(tool) {
  const name = tool.toLowerCase();
  let a = 2166136261;
  let b = 16777619;
  for (let i = 0; i < name.length; i++) {
    a = Math.imul(a ^ name.charCodeAt(i), 16777619);
    b = Math.imul(b ^ name.charCodeAt(i), 16777619);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
function parseEntry(name) {
  if (name.endsWith(CLAIM_SUFFIX)) return void 0;
  const [mintedAt, key, id, lateUntil, extra] = name.split(".");
  if (key === void 0 || id === void 0 || extra !== void 0) return void 0;
  return {
    name,
    mintedAt: Number(mintedAt),
    key,
    id,
    lateUntil: lateUntil === void 0 ? void 0 : Number(lateUntil)
  };
}
function listEntries(dir) {
  try {
    return readdirSync2(dir).sort().flatMap((name) => parseEntry(name) ?? []);
  } catch {
    return void 0;
  }
}
function mintToolUseId(bufferPath, tool, at) {
  const id = MINTED_ID_PREFIX + randomUUID();
  try {
    const dir = mintedIdsDir(bufferPath);
    mkdirSync2(dir, { recursive: true, mode: 448 });
    writeFileSync(join(dir, `${at}.${toolKey(tool)}.${id}`), "", {
      flag: "wx",
      mode: 384
    });
    return id;
  } catch {
    return void 0;
  }
}
function takeMintedToolUseId(bufferPath, tool, at) {
  const dir = mintedIdsDir(bufferPath);
  const key = toolKey(tool);
  for (let listing = 0; listing < MAX_LISTINGS; listing++) {
    const entries = listEntries(dir)?.filter((entry) => entry.key === key);
    if (entries === void 0) return void 0;
    const open = entries.filter((entry) => entry.lateUntil === void 0);
    const counted = entries.filter((entry) => entry.lateUntil !== void 0);
    let contended = false;
    for (const entry of [...open, ...counted]) {
      if (!claim(join(dir, entry.name), unlinkSync3)) {
        contended = true;
        continue;
      }
      const expired = entry.lateUntil === void 0 ? at - entry.mintedAt > OPEN_ENTRY_TTL_MS : at > entry.lateUntil;
      if (!expired) return entry.id;
    }
    if (!contended) return void 0;
  }
  return void 0;
}
function claim(entry, act) {
  const claimPath2 = entry + CLAIM_SUFFIX;
  try {
    closeSync3(openSync3(claimPath2, "wx", 384));
  } catch {
    return false;
  }
  try {
    act(entry);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync3(claimPath2);
    } catch {
    }
  }
}

// src/hooks/collector-script.ts
import { realpathSync } from "node:fs";
var DEFAULT_STORAGE_DIR = resolve3(homedir(), ".newrelic-preflight");
function getStorageDir() {
  return process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
}
function getBufferPath(sessionId) {
  if (process.env.NEW_RELIC_AI_MCP_BUFFER_PATH !== void 0) {
    return process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
  }
  const storageDir = getStorageDir();
  const safeId = typeof sessionId === "string" && SESSION_ID_RE.test(sessionId) ? sessionId : "unknown";
  return resolve3(storageDir, `buffer-${safeId}.jsonl`);
}
var HIGH_SECURITY_FROM_FILE = (() => {
  for (const dir of [".newrelic-preflight", ".nr-ai-observe"]) {
    try {
      const configPath = resolve3(homedir(), dir, "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync2(configPath, "utf-8"));
        return config.highSecurity === true;
      }
    } catch {
    }
  }
  return false;
})();
function getHighSecurity() {
  return process.env.NEW_RELIC_AI_HIGH_SECURITY === "true" || HIGH_SECURITY_FROM_FILE;
}
function getRecordContent() {
  return resolveRecordContent(
    getHighSecurity(),
    process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT === "true"
  );
}
var DEFAULT_MAX_CONTENT_LENGTH = 10240;
var MIN_MAX_CONTENT_LENGTH = 256;
var MAX_MAX_CONTENT_LENGTH = 1048576;
function getMaxContentLength() {
  const val = process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
  if (val === void 0) return DEFAULT_MAX_CONTENT_LENGTH;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed)) return DEFAULT_MAX_CONTENT_LENGTH;
  if (parsed < MIN_MAX_CONTENT_LENGTH) return MIN_MAX_CONTENT_LENGTH;
  if (parsed > MAX_MAX_CONTENT_LENGTH) return MAX_MAX_CONTENT_LENGTH;
  return parsed;
}
var HOOK_EVENT_PLATFORM = {
  beforeshellexecution: "cursor",
  aftershellexecution: "cursor",
  beforemcpexecution: "cursor",
  aftermcpexecution: "cursor",
  beforereadfile: "cursor",
  afterfileedit: "cursor",
  pre_read_code: "windsurf",
  post_read_code: "windsurf",
  pre_write_code: "windsurf",
  post_write_code: "windsurf",
  pre_run_command: "windsurf",
  post_run_command: "windsurf",
  pre_mcp_tool_use: "windsurf",
  post_mcp_tool_use: "windsurf"
};
function detectStampPlatform() {
  for (const key of ENGINE_ENV_KEYS) {
    const name = canonicalPlatformName(process.env[key]);
    if (name !== void 0) return name;
  }
  if (CLAUDE_CODE_ENV_SIGNALS.some((key) => process.env[key] !== void 0)) {
    return CLAUDE_CODE_PLATFORM_NAME;
  }
  return (process.env.MCP_CLIENT ?? process.env.NEW_RELIC_AI_PLATFORM) || void 0;
}
var MAX_REDACT_BYTES = 1048576;
var MAX_CLASSIFY_CHARS = 16384;
function bashCommandInput(command) {
  if (command.length > MAX_CLASSIFY_CHARS) return { command: redact(command) };
  const { isDestructive, isNetwork } = classifyBash(command);
  return { command: redact(command), bashDestructive: isDestructive, bashNetwork: isNetwork };
}
function redact(value) {
  let result = value;
  if (Buffer.byteLength(value, "utf8") > MAX_REDACT_BYTES) {
    const buf = Buffer.from(value, "utf8").subarray(0, MAX_REDACT_BYTES);
    const kept = buf.toString("utf8").replace(/�$/, "");
    result = cutAtWord(value, kept.length);
  }
  return redactSecrets(result);
}
function hashInput(input) {
  const str = JSON.stringify(input) ?? "";
  return createHash2("sha256").update(str).digest("hex").slice(0, 16);
}
function sizeOf(value) {
  if (value === void 0 || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
var TRUNCATED = "...[truncated]";
function truncate(value, maxLen) {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + TRUNCATED;
}
function recordedContent(value, maxLen) {
  const redactUpTo = () => {
    let left = maxLen;
    return (text) => {
      const kept = left > 0 ? redact(text) : TRUNCATED;
      left -= text.length + 2;
      return kept;
    };
  };
  const redactValue = redactUpTo();
  const redactKey = redactUpTo();
  const content = typeof value === "string" ? redactValue(value) : JSON.stringify(value, (_key, v) => {
    if (typeof v === "string") return redactValue(v);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const keys = /* @__PURE__ */ new Set();
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        const base = redactKey(k);
        let key = base;
        for (let n = 2; keys.has(key); n++) key = `${base} (${n})`;
        keys.add(key);
        return [key, x];
      })
    );
  });
  return truncate(content, maxLen);
}
function countLines(text) {
  if (text === "") return 0;
  return (text.match(/\n/g) || []).length + 1;
}
function hasStringText(block) {
  return typeof block === "object" && block !== null && "text" in block && typeof block.text === "string";
}
var _procFs = {
  readFile: (path) => readFileSync2(path, "utf-8")
};
function getLinuxAncestorPids(startPpid, maxDepth = 5) {
  const pids = [startPpid];
  let pid = startPpid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    try {
      const stat = _procFs.readFile(`/proc/${pid}/stat`);
      const lastParen = stat.lastIndexOf(")");
      if (lastParen === -1) break;
      const parentPid = parseInt(stat.slice(lastParen + 2).split(" ")[1] ?? "0", 10);
      if (!Number.isFinite(parentPid) || parentPid <= 1) break;
      if (pids.includes(parentPid)) break;
      pids.push(parentPid);
      pid = parentPid;
    } catch {
      break;
    }
  }
  return pids;
}
function touch(path) {
  const now = /* @__PURE__ */ new Date();
  try {
    utimesSync(path, now, now);
  } catch {
  }
}
function writeOrTouch(dir, name, sessionId) {
  const path = resolve3(dir, name);
  let current;
  try {
    current = readFileSync2(path, "utf-8").trim();
  } catch {
  }
  if (current === sessionId) {
    touch(path);
    return;
  }
  try {
    writeFileSync2(path, sessionId, { mode: 384 });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    mkdirSync3(dir, { recursive: true, mode: 448 });
    writeFileSync2(path, sessionId, { mode: 384 });
  }
}
function breadcrumbRoots(root, legacyRoot) {
  return legacyRoot === void 0 ? [root] : [root, legacyRoot];
}
function writePpidBreadcrumb(sessionId, root, legacyRoot) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  const ppid = process.ppid;
  if (typeof ppid !== "number" || ppid <= 0) return;
  try {
    const pids = getLinuxAncestorPids(ppid);
    for (const dir of breadcrumbRoots(root, legacyRoot)) {
      for (const pid of pids) {
        writeOrTouch(resolve3(dir, "session-by-ppid"), `${pid}.txt`, sessionId);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[preflight-collector] Warning: cannot write PPID breadcrumb: ${String(err)}
`
    );
  }
}
function writeSessionIdBreadcrumb(sessionId, root) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    writeOrTouch(resolve3(root, "session-by-id"), `${sessionId}.txt`, sessionId);
  } catch {
  }
}
function writeCwdBreadcrumb(sessionId, cwd, root, legacyRoot) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  if (typeof cwd !== "string" || cwd.length === 0) return;
  const sanitizedCwd = cwd.replace(/[\\/:]/g, "-");
  try {
    for (const dir of breadcrumbRoots(root, legacyRoot)) {
      writeOrTouch(resolve3(dir, "session-by-cwd"), `${sanitizedCwd}.txt`, sessionId);
    }
  } catch (err) {
    process.stderr.write(
      `[preflight-collector] Warning: cannot write cwd breadcrumb: ${String(err)}
`
    );
  }
}
var UNKNOWN_ENGINE_MARKER = "unknown-engine-warned";
function claimUnknownEngineWarning(storageDir, names) {
  const marker = resolve3(storageDir, UNKNOWN_ENGINE_MARKER);
  try {
    if (readFileSync2(marker, "utf-8") === names) return false;
  } catch {
  }
  try {
    mkdirSync3(storageDir, { recursive: true, mode: 448 });
    writeFileSync2(marker, names, { mode: 384 });
  } catch {
  }
  return true;
}
var GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
function mcpPrInputMeta(input, action) {
  const meta = {};
  const { owner, repo, pullNumber } = input;
  if (typeof owner === "string" && typeof repo === "string" && GITHUB_NAME_RE.test(owner) && GITHUB_NAME_RE.test(repo)) {
    meta.prRepo = `${owner}/${repo}`;
  }
  if (action !== "create") {
    const number = typeof pullNumber === "number" ? String(pullNumber) : pullNumber;
    if (typeof number === "string" && /^[1-9]\d{0,8}$/.test(number)) meta.prNumber = number;
  }
  return meta;
}
function extractInputMeta(toolName, input) {
  if (input === null || input === void 0 || typeof input !== "object") return void 0;
  const obj = input;
  const meta = {};
  if (typeof obj.file_path === "string") meta.file_path = obj.file_path;
  else if (typeof obj.filePath === "string") meta.file_path = obj.filePath;
  const prAction = mcpPrToolAction(toolName);
  if (prAction !== void 0) Object.assign(meta, mcpPrInputMeta(obj, prAction));
  switch (toolName) {
    case "Read":
      if (typeof obj.offset === "number") meta.offset = obj.offset;
      if (typeof obj.limit === "number") meta.limit = obj.limit;
      break;
    case "Write":
    case "create_file":
      if (typeof obj.content === "string") {
        meta.contentLength = obj.content.length;
        meta.lineCount = obj.content.length > 0 ? countLines(obj.content) : 0;
      }
      break;
    // VS Code Copilot's find-and-replace edit tools. Field names are camelCase
    // (oldString/newString) per the hooks FAQ; tool names from toolNames.ts in
    // microsoft/vscode (extensions/copilot/src/extension/tools/common/).
    case "replace_string_in_file": {
      const oldStr = obj.oldString;
      const newStr = obj.newString;
      if (typeof oldStr === "string") {
        meta.oldStringLength = oldStr.length;
        meta.oldLineCount = oldStr.length > 0 ? countLines(oldStr) : 0;
      }
      if (typeof newStr === "string") {
        meta.newStringLength = newStr.length;
        meta.newLineCount = newStr.length > 0 ? countLines(newStr) : 0;
        meta.isDelete = newStr.length === 0;
      }
      break;
    }
    case "multi_replace_string_in_file":
      if (Array.isArray(obj.replacements)) meta.replacementsCount = obj.replacements.length;
      break;
    case "run_in_terminal":
      if (typeof obj.command === "string") Object.assign(meta, bashCommandInput(obj.command));
      if (typeof obj.explanation === "string") meta.description = redact(obj.explanation);
      if (typeof obj.isBackground === "boolean") meta.run_in_background = obj.isBackground;
      break;
    case "Edit":
      if (typeof obj.old_string === "string") {
        meta.oldStringLength = obj.old_string.length;
        meta.oldLineCount = obj.old_string.length > 0 ? countLines(obj.old_string) : 0;
      }
      if (typeof obj.new_string === "string") {
        meta.newStringLength = obj.new_string.length;
        meta.newLineCount = obj.new_string.length > 0 ? countLines(obj.new_string) : 0;
        meta.isDelete = obj.new_string.length === 0;
      }
      if (typeof obj.replace_all === "boolean") meta.replace_all = obj.replace_all;
      break;
    // Amazon Kiro. Tool names and tool_input field names captured from a live
    // Kiro install (42.08, macOS) — `read_file` sends {path, offset, limit} and
    // `str_replace` sends {path, oldStr, newStr, replace_all}. Two deltas from
    // Claude Code worth noting: the file key is `path`, not `file_path`, and the
    // edit strings are `oldStr`/`newStr`, not `old_string`/`new_string`.
    //
    // These are explicit cases rather than hoisting `path` into the
    // name-independent file_path block above, because Grep/Glob also send `path`
    // — there it means a search root, not a file, and promoting it to file_path
    // would misreport searches as file access for every platform.
    //
    // The path Kiro sends is workspace-relative ("cloudformation/export-env.sh"),
    // unlike Claude Code's absolute paths. That's fine for the unique-file
    // counting these fields feed, but don't assume absolute downstream.
    case "read_file":
      if (typeof obj.path === "string") meta.file_path = obj.path;
      if (typeof obj.offset === "number") meta.offset = obj.offset;
      if (typeof obj.limit === "number") meta.limit = obj.limit;
      break;
    case "str_replace": {
      if (typeof obj.path === "string") meta.file_path = obj.path;
      const kiroOld = obj.oldStr;
      const kiroNew = obj.newStr;
      if (typeof kiroOld === "string") {
        meta.oldStringLength = kiroOld.length;
        meta.oldLineCount = kiroOld.length > 0 ? countLines(kiroOld) : 0;
      }
      if (typeof kiroNew === "string") {
        meta.newStringLength = kiroNew.length;
        meta.newLineCount = kiroNew.length > 0 ? countLines(kiroNew) : 0;
        meta.isDelete = kiroNew.length === 0;
      }
      if (typeof obj.replace_all === "boolean") meta.replace_all = obj.replace_all;
      break;
    }
    // PowerShell is a real, first-party Claude Code tool on native Windows,
    // auto-enabled without Git Bash (code.claude.com/docs/en/tools-reference,
    // /setup, /env-vars) — same command/description/timeout/run_in_background
    // input shape as Bash.
    case "Bash":
    case "PowerShell":
      if (typeof obj.command === "string") Object.assign(meta, bashCommandInput(obj.command));
      if (typeof obj.description === "string") meta.description = redact(obj.description);
      if (typeof obj.timeout === "number") meta.timeout = obj.timeout;
      if (typeof obj.run_in_background === "boolean")
        meta.run_in_background = obj.run_in_background;
      break;
    case "Grep":
      if (typeof obj.pattern === "string") meta.pattern = obj.pattern;
      if (typeof obj.path === "string") meta.path = obj.path;
      if (typeof obj.output_mode === "string") meta.output_mode = obj.output_mode;
      break;
    case "Glob":
      if (typeof obj.pattern === "string") meta.pattern = obj.pattern;
      if (typeof obj.path === "string") meta.path = obj.path;
      break;
    case "Agent":
      if (typeof obj.description === "string") meta.description = obj.description;
      if (typeof obj.subagent_type === "string") meta.subagent_type = obj.subagent_type;
      if (typeof obj.prompt === "string") meta.promptLength = obj.prompt.length;
      if (typeof obj.run_in_background === "boolean")
        meta.run_in_background = obj.run_in_background;
      if (typeof obj.name === "string") meta.name = obj.name;
      if (typeof obj.team_name === "string") meta.team_name = obj.team_name;
      if (typeof obj.isolation === "string") meta.isolation = obj.isolation;
      if (typeof obj.model === "string") meta.model = obj.model;
      break;
    case "AskUserQuestion":
      if (Array.isArray(obj.questions)) meta.questions = new Array(obj.questions.length);
      break;
    case "TaskCreate":
      if (typeof obj.subject === "string") meta.subject = obj.subject;
      break;
    case "TaskUpdate":
      if (typeof obj.taskId === "string") meta.taskId = obj.taskId;
      if (typeof obj.status === "string") meta.status = obj.status;
      if (typeof obj.subject === "string") meta.subject = obj.subject;
      break;
    case "Skill":
      if (typeof obj.skill === "string") meta.skill = obj.skill.slice(0, 128);
      if (typeof obj.args === "string") meta.argsLength = obj.args.length;
      break;
  }
  return Object.keys(meta).length > 0 ? meta : void 0;
}
var PR_URL_RE = /https?:\/\/[^\s"'/]+\/([^\s"'/]+)\/([^\s"'/]+)\/pull\/(\d{1,9})\b/g;
var GH_PR_CREATE_RE = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;
function findCreatedPr(output) {
  const texts = [];
  const blocks = Array.isArray(output) ? output : output.content;
  if (!Array.isArray(output) && typeof output.stdout === "string") texts.push(output.stdout);
  if (Array.isArray(blocks)) {
    for (const block of blocks) if (hasStringText(block)) texts.push(block.text);
  }
  const prs = /* @__PURE__ */ new Map();
  for (const text of texts) {
    for (const [, owner, repo, createdPrNumber] of text.matchAll(PR_URL_RE)) {
      const createdPrRepo = parsePrRepo(`${owner}/${repo}`);
      prs.set(`${owner}/${repo}#${createdPrNumber}`.toLowerCase(), {
        createdPrNumber,
        ...createdPrRepo !== void 0 && { createdPrRepo }
      });
    }
  }
  return prs.size === 1 ? [...prs.values()][0] : void 0;
}
function extractOutputMeta(toolName, output, input) {
  if (output === null || output === void 0 || typeof output !== "object") return void 0;
  const obj = output;
  if (mcpPrToolAction(toolName) === "create") {
    return findCreatedPr(output);
  }
  if (toolName === "Bash") {
    const meta = {};
    if (typeof obj.exitCode === "number") {
      meta.exitCode = obj.exitCode;
    } else if (typeof obj.exitCode === "string") {
      const parsed = Number(obj.exitCode);
      if (!Number.isNaN(parsed)) meta.exitCode = parsed;
    }
    const command = input !== null && typeof input === "object" ? input.command : void 0;
    if (typeof command === "string" && GH_PR_CREATE_RE.test(command)) {
      Object.assign(meta, findCreatedPr(obj));
    }
    if (Object.keys(meta).length > 0) return meta;
  }
  if (toolName === "Edit") {
    const meta = {};
    if (typeof obj.success === "boolean") meta.editSuccess = obj.success;
    if (typeof obj.error === "string") meta.editError = obj.error.slice(0, 200);
    if (typeof obj.matched === "boolean") meta.editMatched = obj.matched;
    return Object.keys(meta).length > 0 ? meta : void 0;
  }
  if (toolName === "Grep") {
    const meta = {};
    if (typeof obj.matchCount === "number") meta.grepMatchCount = obj.matchCount;
    else if (Array.isArray(obj.matches)) meta.grepMatchCount = obj.matches.length;
    else if (Array.isArray(obj.results)) meta.grepMatchCount = obj.results.length;
    if (Array.isArray(obj.content)) {
      let lineCount = 0;
      for (const block of obj.content) {
        if (hasStringText(block)) {
          lineCount += block.text.split("\n").length;
        }
      }
      if (lineCount > 0) meta.grepResultLines = lineCount;
    }
    return Object.keys(meta).length > 0 ? meta : void 0;
  }
  if (toolName === "Agent") {
    const meta = {};
    if (typeof obj.completed === "boolean") meta.agentCompleted = obj.completed;
    if (typeof obj.interrupted === "boolean") meta.agentInterrupted = obj.interrupted;
    if (typeof obj.result === "string") meta.agentResultLength = obj.result.length;
    else if (typeof obj.message === "string") meta.agentResultLength = obj.message.length;
    else if (Array.isArray(obj.content)) {
      let totalLen = 0;
      for (const block of obj.content) {
        if (hasStringText(block)) {
          totalLen += block.text.length;
        }
      }
      if (totalLen > 0) meta.agentResultLength = totalLen;
    }
    if (typeof obj.agentId === "string") meta.spawnedAgentId = obj.agentId;
    return Object.keys(meta).length > 0 ? meta : void 0;
  }
  return void 0;
}
function getWindsurfToolInfo(data) {
  return data.tool_info !== null && typeof data.tool_info === "object" ? data.tool_info : {};
}
var stderrSinkInstalled = false;
var POST_ONLY_EVENTS = /* @__PURE__ */ new Set(["beforereadfile", "afterfileedit"]);
function processHook(raw, cliEvent) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const sessionId = data.session_id ?? data.conversation_id ?? data.trajectory_id ?? data.conversationId;
  if (typeof data.session_id === "string" && data.session_id.length > 0) {
    const writer = breadcrumbWriter(process.env);
    const storageDir = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
    if (writer === UNATTRIBUTED_BREADCRUMB_WRITER) {
      const unknownNames = ENGINE_ENV_KEYS.filter(
        (key) => process.env[key] && canonicalPlatformName(process.env[key]) === void 0
      ).map((key) => `${key}=${JSON.stringify(process.env[key])}`).join(", ");
      if (unknownNames.length > 0 && claimUnknownEngineWarning(storageDir, unknownNames)) {
        process.stderr.write(
          `[preflight-collector] Warning: ${unknownNames} names no engine Preflight knows; filing the session breadcrumb as unattributed
`
        );
      }
    }
    const tagged = breadcrumbRoot(storageDir, writer);
    writeSessionIdBreadcrumb(data.session_id, tagged);
    writePpidBreadcrumb(data.session_id, tagged, storageDir);
    writeCwdBreadcrumb(data.session_id, data.cwd, tagged, storageDir);
  }
  const eventName = (data.hook_event_name ?? data.agent_action_name)?.toLowerCase();
  const toolName = data.tool_name ?? "unknown";
  const timestamp = Date.now();
  const recordContent = getRecordContent();
  const maxContentLen = getMaxContentLength();
  const isGeminiCli = ENGINE_ENV_KEYS.some(
    (key) => canonicalPlatformName(process.env[key]) === "gemini-cli"
  );
  const isAntigravityShape = data.hook_event_name === void 0 && data.agent_action_name === void 0 && (data.toolCall !== void 0 || typeof data.stepIdx === "number");
  const agyCliEvent = hookEventFromArg(cliEvent);
  const isAntigravityPost = isAntigravityShape && (agyCliEvent === "PostToolUse" || agyCliEvent !== "PreToolUse" && (data.error !== void 0 || data.toolCall === void 0));
  const isAntigravityPre = isAntigravityShape && !isAntigravityPost;
  const agyToolUseId = typeof data.stepIdx === "number" ? { toolUseId: sessionId ? `${sessionId}:${data.stepIdx}` : String(data.stepIdx) } : {};
  let event;
  let selfReportCall;
  if (eventName === "pretooluse") {
    event = {
      mode: "pre",
      tool: toolName,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input)
    };
    const inputMeta = extractInputMeta(toolName, data.tool_input);
    if (inputMeta !== void 0) event.toolInput = inputMeta;
    if (recordContent && data.tool_input !== void 0) {
      event.inputContent = recordedContent(data.tool_input, maxContentLen);
    }
  } else if (eventName === "posttooluse") {
    const toolResponse = data.tool_response ?? data.tool_result;
    const responseObj = toolResponse !== null && typeof toolResponse === "object" && !Array.isArray(toolResponse) ? toolResponse : void 0;
    const responseSuccess = responseObj === void 0 ? void 0 : responseObj.success !== void 0 ? responseObj.success : responseObj.result_type !== void 0 ? responseObj.result_type !== "failure" : void 0;
    event = {
      mode: "post",
      tool: toolName,
      timestamp,
      outputSize: sizeOf(toolResponse),
      success: typeof responseSuccess === "boolean" ? responseSuccess : true
    };
    if (typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms) && data.duration_ms >= 0) {
      event.nativeDurationMs = data.duration_ms;
    }
    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== void 0) event.toolInput = postInputMeta;
    const outputMeta = extractOutputMeta(toolName, toolResponse, data.tool_input);
    if (outputMeta !== void 0) event.toolOutput = outputMeta;
    if (recordContent && toolResponse !== void 0) {
      event.outputContent = recordedContent(toolResponse, maxContentLen);
    }
  } else if (eventName === "posttoolusefailure") {
    event = {
      mode: "post",
      tool: toolName,
      timestamp,
      success: false,
      error: redact(data.error ?? "unknown error"),
      isInterrupt: data.is_interrupt ?? false
    };
    if (typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms) && data.duration_ms >= 0) {
      event.nativeDurationMs = data.duration_ms;
    }
  } else if (eventName === "permissionrequest" || eventName === "permissiondenied") {
    if (typeof data.tool_use_id !== "string" || data.tool_use_id === "") {
      process.stderr.write(`[preflight-collector] Dropping ${eventName} without tool_use_id
`);
      return;
    }
    event = eventName === "permissionrequest" ? { mode: "permission_request", tool: toolName, timestamp } : {
      mode: "permission_denied",
      tool: toolName,
      timestamp,
      ...typeof data.denied_reason === "string" && data.denied_reason !== "" && { deniedReason: redact(data.denied_reason) }
    };
  } else if (eventName === "beforetool") {
    event = {
      mode: "pre",
      tool: toolName,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input)
    };
    const inputMeta = extractInputMeta(toolName, data.tool_input);
    if (inputMeta !== void 0) event.toolInput = inputMeta;
    if (recordContent && data.tool_input !== void 0) {
      event.inputContent = recordedContent(data.tool_input, maxContentLen);
    }
  } else if (eventName === "aftertool") {
    const toolResponse = data.tool_response;
    const hasError = toolResponse !== null && typeof toolResponse === "object" && !Array.isArray(toolResponse) && toolResponse.error !== void 0;
    event = {
      mode: "post",
      tool: toolName,
      timestamp,
      outputSize: sizeOf(data.tool_response),
      success: !hasError
    };
    const postInputMeta = extractInputMeta(toolName, data.tool_input);
    if (postInputMeta !== void 0) event.toolInput = postInputMeta;
    const outputMeta = extractOutputMeta(toolName, data.tool_response, data.tool_input);
    if (outputMeta !== void 0) event.toolOutput = outputMeta;
    if (recordContent && data.tool_response !== void 0) {
      event.outputContent = recordedContent(data.tool_response, maxContentLen);
    }
  } else if (eventName === "beforeshellexecution") {
    const command = data.command ?? "";
    event = {
      mode: "pre",
      tool: "Bash",
      timestamp,
      inputSize: sizeOf(command),
      inputHash: hashInput(command),
      toolInput: bashCommandInput(command)
    };
  } else if (eventName === "aftershellexecution") {
    event = {
      mode: "post",
      tool: "Bash",
      timestamp,
      success: true
    };
  } else if (eventName === "beforemcpexecution") {
    const mcpTool = data.tool_name ?? "unknown";
    event = {
      mode: "pre",
      tool: mcpTool,
      timestamp,
      inputSize: sizeOf(data.tool_input),
      inputHash: hashInput(data.tool_input)
    };
  } else if (eventName === "aftermcpexecution") {
    const mcpTool = data.tool_name ?? "unknown";
    event = {
      mode: "post",
      tool: mcpTool,
      timestamp,
      success: true
    };
    selfReportCall = {
      tool: mcpTool,
      server: data.mcp_server_name,
      args: data.tool_input,
      result: data.result_json
    };
  } else if (eventName === "beforereadfile") {
    event = {
      mode: "post",
      tool: "Read",
      timestamp,
      success: true,
      ...data.file_path !== void 0 && { toolInput: { file_path: data.file_path } }
    };
    if (recordContent && data.content !== void 0) {
      event.outputContent = recordedContent(data.content, maxContentLen);
    }
  } else if (eventName === "afterfileedit") {
    event = {
      mode: "post",
      tool: "Edit",
      timestamp,
      success: true,
      ...data.file_path !== void 0 && { toolInput: { file_path: data.file_path } }
    };
  } else if (eventName === "pre_read_code") {
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: "pre",
      tool: "Read",
      timestamp,
      inputSize: sizeOf(filePath),
      inputHash: hashInput(filePath),
      ...typeof filePath === "string" && { toolInput: { file_path: filePath } }
    };
  } else if (eventName === "post_read_code") {
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: "post",
      tool: "Read",
      timestamp,
      success: true,
      ...typeof filePath === "string" && { toolInput: { file_path: filePath } }
    };
  } else if (eventName === "pre_write_code") {
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: "pre",
      tool: "Edit",
      timestamp,
      inputSize: sizeOf(filePath),
      inputHash: hashInput(filePath),
      ...typeof filePath === "string" && { toolInput: { file_path: filePath } }
    };
  } else if (eventName === "post_write_code") {
    const filePath = getWindsurfToolInfo(data).file_path;
    event = {
      mode: "post",
      tool: "Edit",
      timestamp,
      success: true,
      ...typeof filePath === "string" && { toolInput: { file_path: filePath } }
    };
  } else if (eventName === "pre_run_command") {
    const commandLineRaw = getWindsurfToolInfo(data).command_line;
    const commandLine = typeof commandLineRaw === "string" ? commandLineRaw : "";
    event = {
      mode: "pre",
      tool: "Bash",
      timestamp,
      inputSize: sizeOf(commandLine),
      inputHash: hashInput(commandLine),
      toolInput: bashCommandInput(commandLine)
    };
  } else if (eventName === "post_run_command") {
    event = {
      mode: "post",
      tool: "Bash",
      timestamp,
      success: true
    };
  } else if (eventName === "pre_mcp_tool_use") {
    const toolInfo = getWindsurfToolInfo(data);
    const mcpTool = typeof toolInfo.mcp_tool_name === "string" ? toolInfo.mcp_tool_name : "unknown";
    event = {
      mode: "pre",
      tool: mcpTool,
      timestamp,
      inputSize: sizeOf(toolInfo.mcp_tool_arguments),
      inputHash: hashInput(toolInfo.mcp_tool_arguments)
    };
  } else if (eventName === "post_mcp_tool_use") {
    const toolInfo = getWindsurfToolInfo(data);
    const mcpTool = typeof toolInfo.mcp_tool_name === "string" ? toolInfo.mcp_tool_name : "unknown";
    event = {
      mode: "post",
      tool: mcpTool,
      timestamp,
      success: true
    };
    selfReportCall = {
      tool: mcpTool,
      server: toolInfo.mcp_server_name,
      args: toolInfo.mcp_tool_arguments,
      result: toolInfo.mcp_result
    };
  } else if (isAntigravityPre) {
    const agyToolName = data.toolCall?.name ?? "unknown";
    event = {
      mode: "pre",
      tool: agyToolName,
      timestamp,
      inputSize: sizeOf(data.toolCall?.args),
      inputHash: hashInput(data.toolCall?.args),
      ...agyToolUseId
    };
    const inputMeta = extractInputMeta(agyToolName, data.toolCall?.args);
    if (inputMeta !== void 0) event.toolInput = inputMeta;
    if (recordContent && data.toolCall?.args !== void 0) {
      event.inputContent = recordedContent(data.toolCall.args, maxContentLen);
    }
  } else if (isAntigravityPost) {
    const hasError = typeof data.error === "string" && data.error !== "";
    event = {
      mode: "post",
      tool: data.toolCall?.name ?? "unknown",
      timestamp,
      success: !hasError,
      ...agyToolUseId,
      ...typeof data.error === "string" && data.error !== "" && { error: redact(data.error) }
    };
  } else if (eventName === "stopfailure") {
    event = {
      mode: "api_failure",
      errorType: data.error ?? "unknown",
      timestamp
    };
    if (recordContent) {
      if (data.error_details !== void 0) {
        event.errorDetails = recordedContent(data.error_details, maxContentLen);
      }
      if (typeof data.last_assistant_message === "string") {
        event.lastAssistantMessage = recordedContent(data.last_assistant_message, maxContentLen);
      }
    }
  } else if (eventName === "sessionstart") {
    event = {
      mode: "session_start",
      timestamp,
      ...typeof data.source === "string" && { source: data.source },
      ...typeof data.seconds_since_last_response === "number" && {
        secondsSinceLastResponse: data.seconds_since_last_response
      },
      ...typeof data.context_tokens === "number" && { contextTokens: data.context_tokens },
      ...typeof data.prompt_cache_likely_expired === "boolean" && {
        promptCacheLikelyExpired: data.prompt_cache_likely_expired
      },
      ...typeof data.estimated_cache_write_usd === "number" && {
        estimatedCacheWriteUsd: data.estimated_cache_write_usd
      }
    };
  } else if (eventName === "instructionsloaded") {
    event = {
      mode: "instructions_loaded",
      filePath: data.file_path ?? "unknown",
      timestamp,
      ...typeof data.memory_type === "string" && { memoryType: data.memory_type },
      ...typeof data.load_reason === "string" && { loadReason: data.load_reason }
    };
  } else if (eventName === "postmodelswitch") {
    event = {
      mode: "model_switch",
      fromModel: data.from_model ?? "unknown",
      toModel: data.to_model ?? "unknown",
      timestamp,
      ...data.requested_model !== void 0 && { requestedModel: data.requested_model },
      ...typeof data.source === "string" && { source: data.source }
    };
  } else if (eventName === "userpromptsubmit") {
    const slashCommand = typeof data.prompt === "string" ? /^\/([A-Za-z0-9_:.\-]+)(?=\s|$)/.exec(data.prompt)?.[1] : void 0;
    event = {
      mode: "user_prompt_submit",
      timestamp,
      ...slashCommand !== void 0 && { slashCommand }
    };
  } else if (eventName === "stop") {
    event = {
      mode: "stop",
      timestamp
    };
  } else {
    return;
  }
  if (data.cwd) event.cwd = data.cwd;
  if (data.transcript_path) event.transcriptPath = data.transcript_path;
  if (data.permission_mode) event.permissionMode = data.permission_mode;
  if (sessionId) event.sessionId = sessionId;
  const stampedPlatform = HOOK_EVENT_PLATFORM[eventName ?? ""] ?? detectStampPlatform();
  if (stampedPlatform) event.platform = stampedPlatform;
  const selfReport = selfReportCall && stampedPlatform && hookSelfReportLine(selfReportCall, sessionId, timestamp, stampedPlatform);
  if (data.tool_use_id) event.toolUseId = data.tool_use_id;
  if (data.agent_id) event.agentId = data.agent_id;
  if (data.agent_type) event.agentType = data.agent_type;
  const newReport = selfReport && claimReport(getStorageDir(), selfReport) ? selfReport : void 0;
  let reportAttempted = false;
  try {
    const bufferPath = getBufferPath(sessionId);
    const bufferDir = dirname3(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync3(bufferDir, { recursive: true, mode: 448 });
    }
    if (event.toolUseId === void 0 && (event.mode === "pre" || event.mode === "post") && !POST_ONLY_EVENTS.has(eventName ?? "")) {
      const id = event.mode === "pre" ? mintToolUseId(bufferPath, String(event.tool), timestamp) : takeMintedToolUseId(bufferPath, String(event.tool), timestamp);
      if (id !== void 0) event.toolUseId = id;
    }
    const line = JSON.stringify(event) + "\n";
    appendToHookBuffer(bufferPath, line);
    if (newReport) {
      reportAttempted = true;
      appendToHookBuffer(bufferPath, JSON.stringify(newReport) + "\n");
    }
  } catch (err) {
    if (newReport && !(reportAttempted && err instanceof LineWrittenError)) {
      releaseReport(getStorageDir(), newReport);
    }
    if (!stderrSinkInstalled) {
      stderrSinkInstalled = true;
      process.stderr.on("error", () => void 0);
    }
    try {
      process.stderr.write(`[preflight-collector] Dropping a hook event: ${String(err)}
`);
    } catch {
    }
  }
  if (isGeminiCli) {
    try {
      process.stdout.write("{}\n");
    } catch {
    }
  }
  if (isAntigravityPre) {
    try {
      process.stdout.write('{"decision":"allow"}\n');
    } catch {
    }
  } else if (isAntigravityPost) {
    try {
      process.stdout.write("{}\n");
    } catch {
    }
  }
}
var _resolvedScript = (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();
var _isDirectExecution = _resolvedScript != null && /collector-script\.[jt]s$/.test(_resolvedScript);
var _stdinFs = {
  readFileSync: (pathOrFd) => readFileSync2(pathOrFd, "utf-8")
};
function readStdinSync() {
  if (process.platform === "win32") {
    return _stdinFs.readFileSync(process.stdin.fd);
  }
  try {
    return _stdinFs.readFileSync("/dev/stdin");
  } catch {
    return _stdinFs.readFileSync(process.stdin.fd);
  }
}
if (_isDirectExecution) {
  try {
    const stdin = readStdinSync();
    if (stdin.trim()) {
      processHook(stdin, process.argv[2]);
    }
  } catch {
  }
}
export {
  _procFs,
  _stdinFs,
  getBufferPath,
  getLinuxAncestorPids,
  getMaxContentLength,
  getRecordContent,
  hashInput,
  processHook,
  readStdinSync,
  redact,
  sizeOf,
  truncate,
  writeCwdBreadcrumb,
  writePpidBreadcrumb
};
