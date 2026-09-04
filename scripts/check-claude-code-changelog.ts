#!/usr/bin/env tsx
/**
 * Fetches anthropics/claude-code's CHANGELOG.md, diffs it against the
 * version this script last saw (stored in CURSOR_PATH), and flags new
 * entries that mention anything Preflight might want to react to (new hook
 * fields/events, cost/usage/pricing changes, OTel changes).
 *
 * Deliberately dumb: a keyword filter with false positives is fine — the
 * goal is turning "remember to go check" into "get told when there's
 * something to check". A human (or a future agent) still does the real
 * triage-against-the-codebase work — this only automates the noticing.
 *
 * Outputs (for the GitHub Actions workflow step to consume):
 *   - GITHUB_OUTPUT: `matched=true|false`
 *   - REPORT_PATH (default: changelog-report.md): the comment/issue body,
 *     written only when matched=true
 *   - CURSOR_PATH (default: changelog-cursor.txt) is rewritten to the
 *     changelog's current top version regardless of whether anything
 *     matched — the workflow reads it back and stores it in the tracking
 *     issue's body, since branch protection forbids pushing it to `main`.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const CURSOR_PATH = resolve(process.cwd(), process.env.CURSOR_PATH ?? 'changelog-cursor.txt');
const REPORT_PATH = resolve(process.cwd(), process.env.REPORT_PATH ?? 'changelog-report.md');
// How far back to scan when the stored cursor version can't be found in the
// fetched changelog at all (first run, or the entry got squashed/renamed) —
// conservative enough to surface a real gap without re-processing the
// entire multi-thousand-line history every time this happens.
const FALLBACK_SCAN_LINES = 300;

const KEYWORDS = [
  'hook',
  'cost',
  'budget',
  'usage',
  'token',
  'duration_ms',
  'agent_id',
  'agent_type',
  'pricing',
  'otel',
  'opentelemetry',
  'cache',
] as const;

const VERSION_HEADER_RE = /^## (\S+)/;

function readCursor(): string | null {
  try {
    return readFileSync(CURSOR_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeGithubOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`[no GITHUB_OUTPUT set] ${name}=${value}`);
    return;
  }
  appendFileSync(outputFile, `${name}=${value}\n`);
}

async function fetchChangelog(): Promise<string> {
  const res = await fetch(CHANGELOG_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${CHANGELOG_URL}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Returns the lines that are "new" since `cursorVersion` — everything above
 * the line matching that version header. When `cursorVersion` is null
 * (first run) or not found in `lines` at all, falls back to the first
 * FALLBACK_SCAN_LINES lines, logging which case applied.
 */
function sliceNewLines(lines: string[], cursorVersion: string | null): string[] {
  if (cursorVersion === null) {
    console.log('No stored cursor — first run. Recording the current top version, no report.');
    return [];
  }
  const cursorLineIndex = lines.findIndex((line) => {
    const m = VERSION_HEADER_RE.exec(line);
    return m !== null && m[1] === cursorVersion;
  });
  if (cursorLineIndex === -1) {
    console.log(
      `Stored cursor version "${cursorVersion}" not found in fetched changelog — falling back to scanning the first ${FALLBACK_SCAN_LINES} lines.`,
    );
    return lines.slice(0, FALLBACK_SCAN_LINES);
  }
  return lines.slice(0, cursorLineIndex);
}

function currentTopVersion(lines: string[]): string | null {
  for (const line of lines) {
    const m = VERSION_HEADER_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}

function matchesKeyword(line: string): string | null {
  const lower = line.toLowerCase();
  for (const kw of KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

function buildReport(newLines: string[]): { matchCount: number; body: string } {
  const bulletLines = newLines.filter((l) => l.trim().startsWith('-'));
  const matches: Array<{ line: string; keyword: string }> = [];
  for (const line of bulletLines) {
    const kw = matchesKeyword(line);
    // Strip the changelog's own leading "- " so the report can prepend its
    // own bullet marker without producing "- - Added ...".
    if (kw) matches.push({ line: line.trim().replace(/^-\s*/, ''), keyword: kw });
  }
  // Dedupe exact-duplicate bullets (the changelog occasionally repeats an
  // entry across a point release and its follow-up patch).
  const seen = new Set<string>();
  const deduped = matches.filter((m) => {
    if (seen.has(m.line)) return false;
    seen.add(m.line);
    return true;
  });

  const today = new Date().toISOString().slice(0, 10);
  const bodyLines = [
    `## Claude Code changelog watch — ${today}`,
    '',
    `Scanned ${newLines.length} new changelog line(s) since the last check; ${deduped.length} matched a keyword worth a look ([\`hook\`, \`cost\`, \`budget\`, \`usage\`, \`token\`, \`duration_ms\`, \`agent_id\`, \`agent_type\`, \`pricing\`, \`otel\`, \`opentelemetry\`, \`cache\`]).`,
    '',
    'This is a dumb keyword filter, not a triage — check each line against the current codebase (`origin/main`) before filing anything; do not assume from the changelog text alone that something is still unaddressed.',
    '',
    ...deduped.map((m) => `- ${m.line}`),
    '',
    `Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md`,
  ];
  return { matchCount: deduped.length, body: bodyLines.join('\n') };
}

async function main(): Promise<void> {
  const cursorVersion = readCursor();
  const changelog = await fetchChangelog();
  const lines = changelog.split('\n');

  const newLines = sliceNewLines(lines, cursorVersion);
  const topVersion = currentTopVersion(lines);

  if (newLines.length === 0) {
    console.log(
      cursorVersion === null
        ? 'First run — cursor recorded, nothing to report.'
        : 'No new changelog entries since last check.',
    );
    writeGithubOutput('matched', 'false');
  } else {
    const { matchCount, body } = buildReport(newLines);
    if (matchCount === 0) {
      console.log(
        `${newLines.length} new line(s), but none matched a keyword — nothing to report.`,
      );
      writeGithubOutput('matched', 'false');
    } else {
      console.log(`${matchCount} matching line(s) found — writing report to ${REPORT_PATH}`);
      writeFileSync(REPORT_PATH, body, 'utf-8');
      writeGithubOutput('matched', 'true');
    }
  }

  if (topVersion !== null && topVersion !== cursorVersion) {
    writeFileSync(CURSOR_PATH, `${topVersion}\n`, 'utf-8');
    console.log(`Cursor updated: ${cursorVersion ?? '(none)'} -> ${topVersion}`);
  } else if (topVersion === null) {
    console.error(
      'Could not find any "## <version>" header in the fetched changelog — leaving cursor unchanged.',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
