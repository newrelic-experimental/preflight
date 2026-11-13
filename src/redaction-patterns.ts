// Canonical secret-redaction patterns. Shared by src/config.ts's redactSensitive()
// (used across the MCP server) and src/hooks/collector-script.ts's redact() (the hot-path
// hook binary, <5ms budget per invocation — this array literal has no runtime cost beyond
// what each consumer already pays). Previously these were two independently-maintained
// copies that silently drifted: collector-script.ts's list fell 8 patterns behind this one.
// Import from here rather than redefining — a single source of truth makes that drift
// structurally impossible.

// JSON escapes, ANSI colour codes and percent-escapes end in a letter or digit, so a flag
// right after one would otherwise look like the middle of a word.
const AFTER_ESCAPE = String.raw`\\[nrt]|\\u[0-9a-fA-F]{4}|\x1b\[[0-9;]{0,20}m|%[0-9a-fA-F]{2}`;
// A backslash-newline joins two lines into one command, raw or JSON-escaped.
const CONTINUATION = String.raw`(?:\\\r?\n|\\\\\\n)`;
// The characters inside one quoted string. A quoted value is capped at 1,000 of them so a quote
// that never closes costs a bounded scan.
const DQ_CHAR = String.raw`(?:[^"\\\n]|${CONTINUATION}|\\.)`;
const JSON_DQ_CHAR = String.raw`(?:[^"\\\n]|\\\\\\"|\\[^"\n])`;
const SQ_CHAR = String.raw`[^'\n]`;
const ANSI_SQ_CHAR = String.raw`(?:[^'\\\n]|\\.)`;
const QUOTED = [
  String.raw`\\"${JSON_DQ_CHAR}{0,1000}\\"`,
  String.raw`"${DQ_CHAR}{0,1000}"`,
  String.raw`\$'${ANSI_SQ_CHAR}{0,1000}'`,
  String.raw`'${SQ_CHAR}{0,1000}'`,
].join('|');
// One shell word: bare characters and quoted strings up to the next unquoted space.
const VALUE = String.raw`(?!${CONTINUATION})(?:${QUOTED}|${CONTINUATION}|\S)+`;
// An explicit = or : always takes the next word, even across a space, because free text such as
// PASSWORD = "x" in a config file looks the same as an empty shell value.
const AFTER_SEPARATOR = String.raw`\s*`;
const FLAG_GAP = String.raw`(?:[ \t]|${CONTINUATION})+(?!-)`;
const P_FLAG_START = String.raw`(?:\s|${AFTER_ESCAPE})-p`;
const HEADER_FLAG = String.raw`(?:-H|--header)(?:[\s=]|${CONTINUATION}){1,8}`;
const HEADER_NAME = String.raw`(?:x-)?(?:api-?key|auth-token|access-token)`;
const HEADER_SEP = String.raw`(?:[ \t]{0,4}:[ \t]{0,4}|[ \t]{1,4})`;

export const REDACTION_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`(?<![a-zA-Z])(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-zA-Z])\s*[=:]${AFTER_SEPARATOR}${VALUE}`,
    'gi',
  ),
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
  // The argument rules start with a literal before any lookbehind. A leading lookbehind runs at
  // every position and tripled the cost of a plain 1 MB command.
  new RegExp(
    String.raw`-(?<=(?:^|[^\w-]|${AFTER_ESCAPE})-)-?(?:[a-z0-9]{1,30}[-_]){0,3}(?:token|password|passwd|secret|(?:api|access|secret|private)[-_]?key)(?:${FLAG_GAP}|=${AFTER_SEPARATOR})${VALUE}`,
    'gi',
  ),
  // -p is a port, parents or preserve flag everywhere else, so only a mysql client's -p<value> counts,
  // and never a docker-style -p3306:3306 port mapping.
  // The lookbehind stops at the previous -p, so each scan covers new text and the cost stays linear.
  new RegExp(
    String.raw`-p(?<=\b(?:mysql(?:dump|admin)?|mariadb)\b(?:${QUOTED}|${CONTINUATION}|(?!${P_FLAG_START})[^\n;|&"'])*${P_FLAG_START})(?![\d.]+:\d)${VALUE}`,
    'g',
  ),
  new RegExp(
    String.raw`${HEADER_NAME}(?:${[
      String.raw`(?<=${HEADER_FLAG}"${HEADER_NAME})${HEADER_SEP}${DQ_CHAR}{1,1000}`,
      String.raw`(?<=${HEADER_FLAG}\\"${HEADER_NAME})${HEADER_SEP}${JSON_DQ_CHAR}{1,1000}`,
      String.raw`(?<=${HEADER_FLAG}'${HEADER_NAME})${HEADER_SEP}${SQ_CHAR}{1,1000}`,
      String.raw`(?<=${HEADER_FLAG}${HEADER_NAME})${HEADER_SEP}[^\s"']+`,
    ].join('|')})`,
    'gi',
  ),
  /aws_secret_access_key(?:[ \t]*[=:][ \t]*|[ \t]+)["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
];
