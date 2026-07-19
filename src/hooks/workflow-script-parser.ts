/**
 * Workflow Script Parser — extracts the declared topology from a persisted
 * workflow script (`workflows/scripts/<name>-wf_<runId>.js`).
 *
 * Implementation: regex-only (`acorn` is not a project dep). The
 * extractor is intentionally narrow — it succeeds only when `meta` is a
 * literal object (no spread, no computed keys, no template literals; trailing
 * commas tolerated). Any deviation triggers `parser_skip`.
 *
 * Counts:
 *   - declared phases  → length of `meta.phases` literal array
 *   - declared agents  → number of top-level `agent(...)` invocations
 *   - declared parallel widths → for each top-level `parallel(...)` call,
 *     number of literal-array thunks if the source is `[a,b,c]`,
 *     otherwise `'dynamic'`.
 *
 * Every `parallel(...)` call site found by the flat regex scan is classified
 * by its own argument syntax, regardless of whether it's nested inside
 * `pipeline(...)`: a literal array (`parallel([a, b, c])`) counts its
 * elements; `parallel(arr.map(...))`, `Array.from(...)`, and any other
 * scope-dependent expression yields `'dynamic'`.
 */

import { existsSync, readFileSync } from 'node:fs';

import { createLogger } from '../shared/index.js';

const logger = createLogger('workflow-script-parser');

const META_START_RE = /export\s+const\s+meta\s*=\s*\{/;
const META_NAME_RE = /\bname\s*:\s*(['"`])([^'"`]+)\1/;
const META_PHASES_RE = /\bphases\s*:\s*\[([^\]]*)\]/m;
const PHASE_TITLE_RE = /title\s*:\s*(['"`])([^'"`]+)\1/g;

const TOP_LEVEL_AGENT_RE = /\bagent\s*\(/g;
const TOP_LEVEL_PHASE_RE = /\bphase\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeclaredTopology {
  /** Workflow name from `meta.name` (declarative metadata, NOT redacted). */
  readonly workflowName: string | null;
  /** Number of declared phases (length of `meta.phases` literal). */
  readonly declaredPhases: number | null;
  /** Number of phase()-call sites in the script body. */
  readonly declaredPhaseCalls: number;
  /** Number of top-level `agent(...)` calls. */
  readonly declaredAgents: number;
  /**
   * For each top-level `parallel(...)` call, the literal-array width when
   * derivable, or 'dynamic' when the source is computed at runtime
   * (Array.from, .map, scope-dependent expression).
   */
  readonly declaredParallelWidths: ReadonlyArray<number | 'dynamic'>;
}

export interface ParseResult {
  readonly status: 'ok' | 'parser_skip';
  readonly reason?: string;
  readonly topology: DeclaredTopology | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseWorkflowScript(path: string): ParseResult {
  if (!existsSync(path)) {
    return { status: 'parser_skip', reason: 'file_not_found', topology: null };
  }
  let source: string;
  try {
    source = readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn('Failed to read workflow script', { path, error: String(err) });
    return { status: 'parser_skip', reason: 'read_error', topology: null };
  }
  return parseWorkflowScriptSource(source);
}

export function parseWorkflowScriptSource(source: string): ParseResult {
  const metaMatch = META_START_RE.exec(source);
  if (!metaMatch) {
    return { status: 'parser_skip', reason: 'no_meta', topology: null };
  }
  const openIdx = metaMatch.index + metaMatch[0].length - 1; // points at `{`
  const closeIdx = findMatchingBracket(source, openIdx, '{', '}');
  if (closeIdx < 0) {
    return { status: 'parser_skip', reason: 'unclosed_meta', topology: null };
  }
  const metaSource = source.slice(openIdx, closeIdx + 1);

  // Reject computed keys, spreads, template literals — positive-match contract.
  if (/\.\.\./m.test(metaSource)) {
    return { status: 'parser_skip', reason: 'meta_uses_spread', topology: null };
  }
  if (/\$\{/.test(metaSource)) {
    return { status: 'parser_skip', reason: 'meta_uses_template_literal', topology: null };
  }
  if (/\[[^\]]+\]\s*:/.test(metaSource)) {
    return { status: 'parser_skip', reason: 'meta_uses_computed_key', topology: null };
  }

  // Extract name
  let workflowName: string | null = null;
  const nameMatch = META_NAME_RE.exec(metaSource);
  if (nameMatch && typeof nameMatch[2] === 'string') workflowName = nameMatch[2];

  // Extract phases array length (counting `title:` occurrences inside the literal).
  let declaredPhases: number | null = null;
  const phasesMatch = META_PHASES_RE.exec(metaSource);
  if (phasesMatch) {
    const phasesBody = phasesMatch[1] ?? '';
    let n = 0;
    PHASE_TITLE_RE.lastIndex = 0;
    while (PHASE_TITLE_RE.exec(phasesBody) !== null) n += 1;
    declaredPhases = n;
  }

  // Body = source after the meta literal.
  const body = source.slice(closeIdx + 1);

  let declaredAgents = 0;
  TOP_LEVEL_AGENT_RE.lastIndex = 0;
  for (const m of body.matchAll(TOP_LEVEL_AGENT_RE)) {
    if (!isInsideStringOrComment(body, m.index ?? 0)) declaredAgents += 1;
  }

  let declaredPhaseCalls = 0;
  TOP_LEVEL_PHASE_RE.lastIndex = 0;
  for (const m of body.matchAll(TOP_LEVEL_PHASE_RE)) {
    if (!isInsideStringOrComment(body, m.index ?? 0)) declaredPhaseCalls += 1;
  }

  const declaredParallelWidths = extractParallelWidths(body);

  return {
    status: 'ok',
    topology: {
      workflowName,
      declaredPhases,
      declaredPhaseCalls,
      declaredAgents,
      declaredParallelWidths,
    },
  };
}

/**
 * Find each `parallel(` call site in the script body and classify its width:
 *   - `parallel([a, b, c])` → 3 (literal array, count the top-level commas)
 *   - anything else (`.map`, `Array.from`, identifiers, expressions) → 'dynamic'
 *
 * A `parallel(...)` call nested inside `pipeline(...)` is found and
 * classified the same way as any other — there is no pipeline-awareness
 * here, only argument-syntax matching.
 */
function extractParallelWidths(body: string): Array<number | 'dynamic'> {
  const out: Array<number | 'dynamic'> = [];
  const re = /\bparallel\s*\(/g;
  re.lastIndex = 0;
  for (const m of body.matchAll(re)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    if (isInsideStringOrComment(body, start)) continue;
    const argsStart = start + (m[0]?.length ?? 0);
    // Skip whitespace.
    let i = argsStart;
    while (i < body.length && /\s/.test(body[i] ?? '')) i += 1;

    // If the next non-space char isn't `[`, the source is computed.
    if (body[i] !== '[') {
      out.push('dynamic');
      continue;
    }
    const arrEnd = findMatchingBracket(body, i, '[', ']');
    if (arrEnd < 0) {
      out.push('dynamic');
      continue;
    }
    const arrContent = body.slice(i + 1, arrEnd);
    const trimmed = arrContent.trim();
    if (!trimmed) {
      out.push(0);
      continue;
    }
    // Strip a single trailing comma so `[a, b, c,]` counts as 3 not 4.
    const noTrailingComma = trimmed.replace(/,\s*$/, '');
    out.push(countTopLevelCommas(noTrailingComma) + 1);
  }
  return out;
}

function findMatchingBracket(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function countTopLevelCommas(src: string): number {
  let count = 0;
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

/**
 * Best-effort check that an offset isn't inside a string literal or
 * single-line comment. Doesn't track block comments — for our regex hits in
 * a hand-written workflow script body, this is sufficient.
 */
function isInsideStringOrComment(src: string, offset: number): boolean {
  // Walk forward from the start of the line to `offset`; if we are inside a
  // string at that point, return true.
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  let inStr: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = lineStart; i < offset; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') return true;
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch as '"' | "'" | '`';
  }
  return inStr !== null;
}
