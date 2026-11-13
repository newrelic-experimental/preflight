#!/usr/bin/env node

// src/hooks/collector-script.ts
import { readFileSync as readFileSync2, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { resolve as resolve2, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// src/redaction-patterns.ts
var AFTER_ESCAPE = String.raw`\\[nrt]|\\u[0-9a-fA-F]{4}|\x1b\[[0-9;]{0,20}m|%[0-9a-fA-F]{2}`;
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
  String.raw`((?:-H|--header)(?:[\s=]|${CONTINUATION}){1,8}(\\"|"|')?)(?:x-)?(?:api-?key|auth-token|access-token)(?:[ \t]{0,4}:[ \t]{0,4}|[ \t]{1,4})`,
  "gi"
);
var headerValue = (text, match, quote, spans) => {
  const from = match.index + match[0].length;
  const opener = match[2];
  const double = opener === '"' || opener === '\\"' && quote === "double";
  const end = readValue(text, from, quote, opener === "'" ? "single" : double ? "double" : "none");
  return pushValue(spans, match.index + match[1].length, from, end);
};
var NAME = /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-z])[ \t]*[=:][ \t]*/gi;
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
var MYSQL = /\b(?:mysql(?:dump|admin)?|mariadb)\b/g;
var ESCAPED_P = new RegExp(String.raw`(?<=${AFTER_ESCAPE})-p`, "y");
var PORT_MAPPING = /[\d.]+:\d/y;
var REDIRECT = /&>>?|[<>][<>&|]*/y;
var mysqlPasswords = (text, match, quote, spans) => {
  let i = match.index + match[0].length;
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
    const flag = passwordFlag(text, i, end);
    if (flag >= 0) spans.push(flag, end);
    i = end;
  }
};
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
var RULES = [
  { start: HEADER, redact: headerValue },
  { start: NAME, redact: nameValue },
  ...REDACTION_PATTERNS,
  { start: FLAG, redact: wordValue },
  { start: MYSQL, redact: mysqlPasswords }
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

// src/hooks/session-breadcrumbs.ts
import { resolve } from "node:path";

// src/platforms/types.ts
var UNATTRIBUTED_BREADCRUMB_WRITER = "unattributed";

// src/hooks/session-breadcrumbs.ts
var BREADCRUMBS_DIR = "breadcrumbs";
var WRITER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function breadcrumbRoot(storagePath, writer) {
  return resolve(storagePath, BREADCRUMBS_DIR, writer);
}
function breadcrumbWriter(engine) {
  return engine !== void 0 && WRITER_RE.test(engine) ? engine : UNATTRIBUTED_BREADCRUMB_WRITER;
}

// src/storage/hook-buffer.ts
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
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
  const now = statSync(path, { bigint: true, throwIfNoEntry: false });
  return now !== void 0 && now.ino === file.ino && now.dev === file.dev;
}
function appendOnce(path, data) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 384);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!isAt(path, opened)) return "moved";
    const sealFloor = Number(opened.size);
    const written = writeSync(fd, data);
    if (written < data.length) {
      writeSync(fd, TORN_LINE_END);
      return "redo";
    }
    if (isAt(path, opened)) return "kept";
    const start = offsetAfterWrite(fd) - data.length;
    return readRange(fd, sealFloor, start).includes(DRAIN_SEAL) ? "redo" : "kept";
  } finally {
    closeSync(fd);
  }
}
function appendToHookBuffer(path, text) {
  if (text.includes("\0")) {
    throw new Error(`Hook buffer text contains NUL, which marks a drain seal: ${path}`);
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error(`Hook buffer text must be exactly one newline-terminated line: ${path}`);
  }
  const data = Buffer.from(text);
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

// src/hooks/collector-script.ts
import { realpathSync } from "node:fs";
var SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
var DEFAULT_STORAGE_DIR = resolve2(homedir(), ".newrelic-preflight");
function getBufferPath(sessionId) {
  if (process.env.NEW_RELIC_AI_MCP_BUFFER_PATH !== void 0) {
    return process.env.NEW_RELIC_AI_MCP_BUFFER_PATH;
  }
  const storageDir = process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR;
  const safeId = typeof sessionId === "string" && SESSION_ID_RE.test(sessionId) ? sessionId : "unknown";
  return resolve2(storageDir, `buffer-${safeId}.jsonl`);
}
var HIGH_SECURITY_FROM_FILE = (() => {
  for (const dir of [".newrelic-preflight", ".nr-ai-observe"]) {
    try {
      const configPath = resolve2(homedir(), dir, "config.json");
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
function getMaxContentLength() {
  const val = process.env.NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH;
  if (val === void 0) return 10240;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? 10240 : parsed;
}
function detectStampPlatform() {
  const explicit = process.env.MCP_CLIENT ?? process.env.NEW_RELIC_AI_PLATFORM;
  if (explicit) return explicit;
  return CLAUDE_CODE_ENV_SIGNALS.some((key) => process.env[key] !== void 0) ? CLAUDE_CODE_PLATFORM_NAME : void 0;
}
var MAX_REDACT_BYTES = 1048576;
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
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
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
function truncate(value, maxLen) {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...[truncated]";
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
var _breadcrumbWriteFailed = false;
function writePpidBreadcrumb(sessionId, root) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  const ppid = process.ppid;
  if (typeof ppid !== "number" || ppid <= 0) return;
  try {
    const breadcrumbDir = resolve2(root, "session-by-ppid");
    mkdirSync(breadcrumbDir, { recursive: true, mode: 448 });
    const pids = getLinuxAncestorPids(ppid);
    let wroteAny = false;
    for (const pid of pids) {
      const breadcrumbPath = resolve2(breadcrumbDir, `${pid}.txt`);
      if (existsSync(breadcrumbPath)) {
        try {
          if (readFileSync2(breadcrumbPath, "utf-8").trim() === sessionId) {
            const now = /* @__PURE__ */ new Date();
            try {
              utimesSync(breadcrumbPath, now, now);
            } catch {
            }
            wroteAny = true;
            continue;
          }
        } catch {
        }
      }
      writeFileSync(breadcrumbPath, sessionId, { mode: 384 });
      wroteAny = true;
    }
    if (wroteAny) _breadcrumbWriteFailed = false;
  } catch (err) {
    if (!_breadcrumbWriteFailed) {
      process.stderr.write(
        `[preflight-collector] Warning: cannot write PPID breadcrumb: ${String(err)}
`
      );
      _breadcrumbWriteFailed = true;
    }
  }
}
var _cwdBreadcrumbWriteFailed = false;
function writeCwdBreadcrumb(sessionId, cwd, root) {
  if (!SESSION_ID_RE.test(sessionId)) return;
  if (typeof cwd !== "string" || cwd.length === 0) return;
  try {
    const breadcrumbDir = resolve2(root, "session-by-cwd");
    mkdirSync(breadcrumbDir, { recursive: true, mode: 448 });
    const sanitizedCwd = cwd.replace(/[\\/:]/g, "-");
    const breadcrumbPath = resolve2(breadcrumbDir, `${sanitizedCwd}.txt`);
    if (existsSync(breadcrumbPath)) {
      try {
        if (readFileSync2(breadcrumbPath, "utf-8").trim() === sessionId) {
          _cwdBreadcrumbWriteFailed = false;
          return;
        }
      } catch {
      }
    }
    writeFileSync(breadcrumbPath, sessionId, { mode: 384 });
    _cwdBreadcrumbWriteFailed = false;
  } catch (err) {
    if (!_cwdBreadcrumbWriteFailed) {
      process.stderr.write(
        `[preflight-collector] Warning: cannot write cwd breadcrumb: ${String(err)}
`
      );
      _cwdBreadcrumbWriteFailed = true;
    }
  }
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
      if (typeof obj.command === "string") meta.command = redact(obj.command);
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
      if (typeof obj.command === "string") meta.command = redact(obj.command);
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
var PR_URL_RE = /https?:\/\/[^\s"'/]+\/[^\s"'/]+\/[^\s"'/]+\/pull\/(\d{1,9})\b/g;
var GH_PR_CREATE_RE = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;
function findCreatedPrNumber(output) {
  const texts = [];
  const blocks = Array.isArray(output) ? output : output.content;
  if (!Array.isArray(output) && typeof output.stdout === "string") texts.push(output.stdout);
  if (Array.isArray(blocks)) {
    for (const block of blocks) if (hasStringText(block)) texts.push(block.text);
  }
  const prNumbers = /* @__PURE__ */ new Set();
  for (const text of texts) {
    for (const match of text.matchAll(PR_URL_RE)) prNumbers.add(match[1]);
  }
  return prNumbers.size === 1 ? [...prNumbers][0] : void 0;
}
function extractOutputMeta(toolName, output, input) {
  if (output === null || output === void 0 || typeof output !== "object") return void 0;
  const obj = output;
  if (mcpPrToolAction(toolName) === "create") {
    const createdPrNumber = findCreatedPrNumber(output);
    return createdPrNumber === void 0 ? void 0 : { createdPrNumber };
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
      const createdPrNumber = findCreatedPrNumber(obj);
      if (createdPrNumber !== void 0) meta.createdPrNumber = createdPrNumber;
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
function processHook(raw, cliEvent) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const sessionId = data.session_id ?? data.conversation_id ?? data.trajectory_id ?? data.conversationId;
  if (typeof data.session_id === "string" && data.session_id.length > 0) {
    const root = breadcrumbRoot(
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ?? DEFAULT_STORAGE_DIR,
      breadcrumbWriter(detectStampPlatform())
    );
    writePpidBreadcrumb(data.session_id, root);
    writeCwdBreadcrumb(data.session_id, data.cwd, root);
  }
  const eventName = (data.hook_event_name ?? data.agent_action_name)?.toLowerCase();
  const toolName = data.tool_name ?? "unknown";
  const timestamp = Date.now();
  const recordContent = getRecordContent();
  const maxContentLen = getMaxContentLength();
  const isGeminiCli = process.env.MCP_CLIENT === "gemini-cli" || process.env.NEW_RELIC_AI_PLATFORM === "gemini-cli";
  const isAntigravityShape = data.hook_event_name === void 0 && data.agent_action_name === void 0 && (data.toolCall !== void 0 || typeof data.stepIdx === "number");
  const agyCliEvent = hookEventFromArg(cliEvent);
  const isAntigravityPost = isAntigravityShape && (agyCliEvent === "PostToolUse" || agyCliEvent !== "PreToolUse" && (data.error !== void 0 || data.toolCall === void 0));
  const isAntigravityPre = isAntigravityShape && !isAntigravityPost;
  const agyToolUseId = typeof data.stepIdx === "number" ? { toolUseId: String(data.stepIdx) } : {};
  let event;
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
      const content = typeof data.tool_input === "string" ? data.tool_input : JSON.stringify(data.tool_input);
      event.inputContent = redact(truncate(content, maxContentLen));
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
      const content = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
      event.outputContent = redact(truncate(content, maxContentLen));
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
      const content = typeof data.tool_input === "string" ? data.tool_input : JSON.stringify(data.tool_input);
      event.inputContent = redact(truncate(content, maxContentLen));
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
      const content = typeof data.tool_response === "string" ? data.tool_response : JSON.stringify(data.tool_response);
      event.outputContent = redact(truncate(content, maxContentLen));
    }
  } else if (eventName === "beforeshellexecution") {
    const command = data.command ?? "";
    event = {
      mode: "pre",
      tool: "Bash",
      timestamp,
      inputSize: sizeOf(command),
      inputHash: hashInput(command),
      toolInput: { command: redact(command) }
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
  } else if (eventName === "beforereadfile") {
    event = {
      mode: "post",
      tool: "Read",
      timestamp,
      success: true,
      ...data.file_path !== void 0 && { toolInput: { file_path: data.file_path } }
    };
    if (recordContent && data.content !== void 0) {
      event.outputContent = redact(truncate(data.content, maxContentLen));
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
      toolInput: { command: redact(commandLine) }
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
      event.inputContent = redact(truncate(JSON.stringify(data.toolCall.args), maxContentLen));
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
        const details = typeof data.error_details === "string" ? data.error_details : JSON.stringify(data.error_details);
        event.errorDetails = redact(truncate(details, maxContentLen));
      }
      if (typeof data.last_assistant_message === "string") {
        event.lastAssistantMessage = redact(truncate(data.last_assistant_message, maxContentLen));
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
  const stampedPlatform = detectStampPlatform();
  if (stampedPlatform) event.platform = stampedPlatform;
  if (data.tool_use_id) event.toolUseId = data.tool_use_id;
  if (data.agent_id) event.agentId = data.agent_id;
  if (data.agent_type) event.agentType = data.agent_type;
  try {
    const bufferPath = getBufferPath(sessionId);
    const bufferDir = dirname(bufferPath);
    if (!existsSync(bufferDir)) {
      mkdirSync(bufferDir, { recursive: true, mode: 448 });
    }
    const line = JSON.stringify(event) + "\n";
    appendToHookBuffer(bufferPath, line);
  } catch (err) {
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
