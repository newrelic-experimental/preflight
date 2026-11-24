import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ByteEstimateLedger } from '../metrics/cost-tracker.js';
import {
  addSummaries,
  byWriteOrder,
  combineSessionFiles,
  deserializeFullSessionSummary,
  exactTotalsOf,
  mergeSummaries,
  savedToolNameByUseId,
  subtractCallUsageParts,
  subtractSummaries,
  warnOnce,
  type FullSessionSummary,
  type SerializedFullSessionSummary,
} from './session-store.js';

/**
 * Each writer's files for session `<sid>` live in `sessions/.writers/<sid>/`,
 * never beside the index, where an older build would read them as more of the
 * session and set them aside once it combined them.
 */
export const WRITERS_DIR = '.writers';
const LEGACY_PREFIX = 'legacy.';
/**
 * One writer's own share of a session: only what this process drained, never a
 * total seeded from the saved file. Hook events and transcript turns are each
 * drained once, so shares add, except a call whose pre and post two engines
 * drained. Its counts must include every call its timeline holds by toolUseId,
 * under that entry's tool name, so the fold can take the repeat back out.
 */
export interface WriterContribution {
  readonly summary: FullSessionSummary;
  /** This writer saw a real token report replace the session's byte estimates. */
  readonly retracted: boolean;
}

const NO_ESTIMATES: ByteEstimateLedger = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  costByModel: {},
  costByDayUsd: {},
};

/**
 * The session every writer's share adds up to. Inputs fold oldest writer first,
 * so the result does not depend on the order they are listed in. One call two
 * engines both drained counts once where the timelines carry its toolUseId.
 * Retraction is a fact about the session, so one retracted writer drops every
 * writer's estimates.
 */
export function foldWriterContributions(
  contributions: readonly [WriterContribution, ...WriterContribution[]],
): FullSessionSummary {
  const retracted = contributions.some((c) => c.retracted);
  const summaries = contributions
    .map((c) => (retracted ? withoutEstimates(c.summary) : c.summary))
    .sort(byWriteOrder);
  const sum = summaries.reduce((a, b) => addSummaries(a, b));
  const repeats = repeatedCallNames(summaries);
  if (repeats.length === 0) return sum;
  const toolBreakdown = { ...sum.toolBreakdown };
  for (const name of repeats) toolBreakdown[name] -= 1;
  return {
    ...sum,
    toolCallCount: sum.toolCallCount - repeats.length,
    toolBreakdown,
    bashCommandCount: sum.bashCommandCount - repeats.filter((name) => name === 'Bash').length,
  };
}

/**
 * The top-level files for a session as one more writer: what they hold beyond
 * the writer files. Older builds keep saving there, on top of what they read,
 * which can already include the writer files. Every top-level file counts, so a session
 * split across several is captured whole. Pass writer files only, never an
 * earlier capture: each capture is a cumulative view of the same history, so
 * readers combine captures by max and add that once. An older build saves its
 * estimates as an all-zero ledger once a real report replaced them, so that
 * ledger carries the session's retraction.
 */
export function captureLegacyIndex(
  indexFiles: readonly [FullSessionSummary, ...FullSessionSummary[]],
  writers: readonly WriterContribution[],
): WriterContribution {
  const index = combineSessionFiles(indexFiles);
  const summary =
    writers.length === 0
      ? index
      : subtractSummaries(index, foldWriterContributions(writers as [WriterContribution]));
  const ledger = index.byteEstimates;
  const retracted =
    ledger !== undefined &&
    ledger.costUsd === 0 &&
    ledger.inputTokens === 0 &&
    ledger.outputTokens === 0;
  return { summary, retracted };
}

function repeatedCallNames(summaries: readonly FullSessionSummary[]): string[] {
  const seen = new Set<string>();
  const repeats: string[] = [];
  for (const summary of summaries) {
    for (const [toolUseId, toolName] of savedToolNameByUseId(summary)) {
      if (seen.has(toolUseId)) repeats.push(toolName);
      else seen.add(toolUseId);
    }
  }
  return repeats;
}

function withoutEstimates(s: FullSessionSummary): FullSessionSummary {
  const ledger = s.byteEstimates;
  if (ledger === undefined) return s;
  const exact = exactTotalsOf(s);
  return {
    ...s,
    estimatedCostUsd: exact.costUsd,
    costByDayUsd: s.costByDayUsd && exact.costByDayUsd,
    tokensInput: exact.inputTokens,
    tokensOutput: exact.outputTokens,
    ...subtractCallUsageParts(s, ledger),
    byteEstimates: NO_ESTIMATES,
  };
}

export interface IndexFile {
  readonly summary: FullSessionSummary;
  readonly isProjection: boolean;
}

export interface WriterFiles {
  readonly writers: readonly WriterContribution[];
  readonly legacyCaptures: readonly WriterContribution[];
}

export function readWriterFiles(sessionsDir: string, sessionId: string): WriterFiles | null {
  const dir = join(sessionsDir, WRITERS_DIR, sessionId);
  const names = listDirOrEmpty(dir).filter(
    (name) => name.endsWith('.json') && !name.startsWith('.'),
  );
  const writers: WriterContribution[] = [];
  const legacyCaptures: WriterContribution[] = [];
  for (const name of names.sort()) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseWriterFile(raw, sessionId);
    if (!parsed) {
      warnOnce(`writer:${join(dir, name)}`, 'Skipping a writer file that does not parse', {
        sessionId,
        file: name,
      });
    } else if (name.startsWith(LEGACY_PREFIX)) {
      legacyCaptures.push(parsed);
    } else {
      writers.push(parsed);
    }
  }
  return writers.length + legacyCaptures.length === 0 ? null : { writers, legacyCaptures };
}

export function foldSessionFiles(
  index: readonly [IndexFile, ...IndexFile[]],
  files: WriterFiles,
): FullSessionSummary {
  const legacy = [...files.legacyCaptures];
  if (index.some((f) => !f.isProjection)) {
    legacy.push(
      captureLegacyIndex(index.map((f) => f.summary) as [FullSessionSummary], files.writers),
    );
  }
  const parts = legacy.length > 0 ? [...files.writers, maxOfCaptures(legacy)] : files.writers;
  return foldWriterContributions(parts as [WriterContribution]);
}

function maxOfCaptures(captures: readonly WriterContribution[]): WriterContribution {
  const summaries = captures.map((c) => c.summary).sort(byWriteOrder);
  return {
    summary: summaries.reduce((a, b) => mergeSummaries(a, b)),
    retracted: captures.some((c) => c.retracted),
  };
}

export function listDirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function parseWriterFile(raw: string, sessionId: string): WriterContribution | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const { version, retracted, summary } = doc as Record<string, unknown>;
  if (version !== 1 || typeof retracted !== 'boolean') return null;
  if (typeof summary !== 'object' || summary === null) return null;
  const parsed = deserializeFullSessionSummary(summary as SerializedFullSessionSummary);
  return parsed.sessionId === sessionId ? { summary: parsed, retracted } : null;
}
