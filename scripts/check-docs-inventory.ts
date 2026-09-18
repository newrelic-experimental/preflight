#!/usr/bin/env tsx
/**
 * Docs-vs-code drift checker for the cloud-egress inventory.
 *
 * Four checks:
 *   1. Every event type this app actually emits (`eventType: '<Name>'`
 *      literals under src/) must be named in both docs/METRICS_TABLE.md and
 *      PRIVACY.md.
 *   2. Every `ai.category.name`-shaped metric token documented in
 *      docs/METRICS_TABLE.md must trace back to a real string literal
 *      somewhere in src/ (no phantom metrics).
 *   3. Every `nr_observe_*` MCP tool literal under src/ must be named in
 *      docs/COMMANDS_TABLE.md.
 *   4. Every `NEW_RELIC_AI_*` env var read in src/config.ts must be named in
 *      at least one user-facing doc (README.md, SECURITY.md, PRIVACY.md, or a
 *      file under docs/).
 *
 * Does not adjudicate *which* tracker metrics are actually wired into the
 * harvest loop — that nuance stays prose in METRICS_TABLE.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = resolve(ROOT, 'src');
const CONFIG_SRC_PATH = resolve(SRC_DIR, 'config.ts');
const METRICS_DOC_PATH = resolve(ROOT, 'docs/METRICS_TABLE.md');
const PRIVACY_DOC_PATH = resolve(ROOT, 'PRIVACY.md');
const COMMANDS_DOC_PATH = resolve(ROOT, 'docs/COMMANDS_TABLE.md');
const DOCS_DIR = resolve(ROOT, 'docs');
// Env-var surface: the docs a user reads when configuring the server. The
// changelog is history rather than reference material, and the kiro-power
// skill bundle restates docs/KIRO_POWER.md, so neither is part of the corpus.
const ENV_DOC_ROOT_PATHS = ['README.md', 'SECURITY.md', 'PRIVACY.md'].map((name) =>
  resolve(ROOT, name),
);

// 'web' is the built SPA, not server code. 'shared' is a vendored snapshot
// (CLAUDE.md: never edit it) whose own event/test vocabulary is far broader
// than what this app wires up — scanning it would flag things like the
// vendored `AiMessage`/`AiRequest` events this app never sends. '*.test.ts'
// files declare fixture event names ('Session1', 'dropped', ...) that are
// mock data, not real emissions. All three would drown real drift in noise.
// The `nr_observe_*` scan reuses the same file set for the same reasons.
const SKIP_DIR_NAMES = new Set(['web', 'shared', 'node_modules']);

const EVENT_TYPE_RE = /eventType:\s*'([A-Za-z0-9_]+)'/g;
const METRIC_TOKEN_RE = /\bai\.[a-z0-9_]+(?:\.[a-z0-9_]+)+\b/g;
const TOOL_NAME_RE = /\bnr_observe_[a-z0-9_]+\b/g;
const ENV_VAR_RE = /\bNEW_RELIC_AI_[A-Z0-9_]+\b/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const files = collectSourceFiles(SRC_DIR);

  const emittedEvents = new Set<string>();
  const srcMetricTokens = new Set<string>();
  const toolNames = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(EVENT_TYPE_RE)) emittedEvents.add(m[1]);
    for (const m of text.matchAll(METRIC_TOKEN_RE)) srcMetricTokens.add(m[0]);
    for (const m of text.matchAll(TOOL_NAME_RE)) toolNames.add(m[0]);
  }

  // Env vars are read in one place (the config loader), so this scans that
  // file only rather than the whole tree.
  const configText = readFileSync(CONFIG_SRC_PATH, 'utf8');
  const envVars = new Set<string>();
  for (const m of configText.matchAll(ENV_VAR_RE)) envVars.add(m[0]);

  const metricsDoc = readFileSync(METRICS_DOC_PATH, 'utf8');
  const privacyDoc = readFileSync(PRIVACY_DOC_PATH, 'utf8');
  const commandsDoc = readFileSync(COMMANDS_DOC_PATH, 'utf8');

  const missingFromMetricsDoc = [...emittedEvents].filter((e) => !metricsDoc.includes(e)).sort();
  const missingFromPrivacyDoc = [...emittedEvents].filter((e) => !privacyDoc.includes(e)).sort();

  const docMetricTokens = new Set(metricsDoc.match(METRIC_TOKEN_RE) ?? []);
  const phantomMetrics = [...docMetricTokens].filter((t) => !srcMetricTokens.has(t)).sort();

  const missingFromCommandsDoc = [...toolNames].filter((t) => !commandsDoc.includes(t)).sort();

  const envDocText = [
    ...ENV_DOC_ROOT_PATHS,
    ...readdirSync(DOCS_DIR)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join(DOCS_DIR, entry)),
  ]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const undocumentedEnvVars = [...envVars].filter((v) => !envDocText.includes(v)).sort();

  let ok = true;

  if (missingFromMetricsDoc.length > 0) {
    ok = false;
    console.error('Event types emitted in src/ but undocumented in docs/METRICS_TABLE.md:');
    for (const e of missingFromMetricsDoc) console.error(`  - ${e}`);
  }
  if (missingFromPrivacyDoc.length > 0) {
    ok = false;
    console.error('Event types emitted in src/ but undocumented in PRIVACY.md:');
    for (const e of missingFromPrivacyDoc) console.error(`  - ${e}`);
  }
  if (phantomMetrics.length > 0) {
    ok = false;
    console.error('Metric names in docs/METRICS_TABLE.md with no matching literal in src/:');
    for (const t of phantomMetrics) console.error(`  - ${t}`);
  }
  if (missingFromCommandsDoc.length > 0) {
    ok = false;
    console.error('MCP tools registered in src/ but undocumented in docs/COMMANDS_TABLE.md:');
    for (const t of missingFromCommandsDoc) console.error(`  - ${t}`);
  }
  if (undocumentedEnvVars.length > 0) {
    ok = false;
    console.error('Env vars read in src/config.ts but named in no user-facing doc:');
    for (const v of undocumentedEnvVars) console.error(`  - ${v}`);
  }

  if (!ok) {
    console.error('\n✗ FAIL: docs/code inventory drift found (see above)');
    process.exit(1);
  }

  console.log(
    `✓ OK: ${emittedEvents.size} emitted event types documented in both docs, ` +
      `${docMetricTokens.size} documented metric names all trace to src/, ` +
      `${toolNames.size} MCP tools documented in docs/COMMANDS_TABLE.md, ` +
      `${envVars.size} config env vars named in the docs.`,
  );
}

main();
