import { linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ByteEstimateLedger } from '../metrics/cost-tracker.js';
import { renameIntoPlace } from './rename-into-place.js';
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
export const LEGACY_PREFIX = 'legacy.';

/** The code path that saves a contribution. Two producers in one process are two writers. */
export type Producer = 'engine' | 'aggregator' | 'homelab';

export type SaveResult =
  | {
      readonly kind: 'saved';
      /** The session is retracted, so a writer still estimating must stop. */
      readonly retracted: boolean;
    }
  | { readonly kind: 'skipped'; readonly reason: 'invalid-session-id' | 'no-recorded-usage' }
  | { readonly kind: 'failed'; readonly error: string };

/** Writes one writer's file in each session it saves, and nothing another writer wrote. */
export interface SessionWriter {
  readonly id: string;
  /** Replaces this writer's whole share of the session, then rewrites the index from every share. */
  save(contribution: WriterContribution): SaveResult;
  /** Deletes this writer's share of a session it saved by mistake, then rewrites the index. */
  retire(sessionId: string): void;
}

/**
 * `<producer>.<pid>.<startedAt36>.<rand8>`, new for every process lifetime and
 * producer. A dead writer's file is final data that no one writes again.
 */
export function newWriterId(producer: Producer): string {
  return `${producer}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}`;
}

export function writerFileBody({ summary, retracted }: WriterContribution): string {
  return JSON.stringify({ version: 1, retracted, summary }, null, 2) + '\n';
}

function tmpPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
}

/** Replaces `path` whole, so a reader sees the old body or the new one. */
export function writeAtomic(path: string, body: string): void {
  const tmp = tmpPathFor(path);
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameIntoPlace(tmp, path, body);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Creates `path` unless it exists. The first body wins, and no reader sees it half written. */
export function createOnce(path: string, body: string): void {
  const tmp = tmpPathFor(path);
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}
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
 * estimates as an all-zero ledger once a real report replaced them. Retraction
 * is a fact about the session, so any top-level file with that ledger carries it.
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
  return { summary, retracted: indexFiles.some(savedRetraction) };
}

function savedRetraction({ byteEstimates: ledger }: FullSessionSummary): boolean {
  return (
    ledger !== undefined &&
    ledger.costUsd === 0 &&
    ledger.inputTokens === 0 &&
    ledger.outputTokens === 0
  );
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

/** The session the index files and writer files hold, and whether it is retracted. */
export function foldSessionFiles(
  index: readonly IndexFile[],
  files: WriterFiles,
): WriterContribution {
  const legacy = [...files.legacyCaptures];
  if (index.some((f) => !f.isProjection)) {
    legacy.push(
      captureLegacyIndex(index.map((f) => f.summary) as [FullSessionSummary], files.writers),
    );
  }
  const parts = legacy.length > 0 ? [...files.writers, maxOfCaptures(legacy)] : files.writers;
  return {
    summary: foldWriterContributions(parts as [WriterContribution]),
    retracted: parts.some((p) => p.retracted),
  };
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
