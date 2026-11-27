import { linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ByteEstimateLedger } from '../metrics/cost-tracker.js';
import { renameIntoPlace } from './rename-into-place.js';
import {
  addSummaries,
  byWriteOrder,
  callIndex,
  combineSessionFiles,
  deserializeFullSessionSummary,
  exactTotalsOf,
  subtractCallUsageParts,
  subtractSummaries,
  warnOnce,
  type FullSessionSummary,
  type SerializedFullSessionSummary,
} from './session-store.js';
import type { ReplayTimelineEntry } from './types.js';

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
 * drained once, so shares add, except a call two writers hold: one whose pre
 * and post two engines drained, or one an engine replayed at adoption that the
 * rollup it saved then also holds. Its counts must include every call its
 * timeline holds, under that entry's tool name, so the fold can take the
 * repeat back out.
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
 * writers both hold counts once, in the counts and the success rate, where both
 * timelines carry it: by its toolUseId, else by its timestamp and tool name.
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
  const sum = {
    ...summaries.reduce((a, b) => addSummaries(a, b)),
    toolSuccessRate: foldedToolSuccessRate(summaries),
  };
  const repeats = repeatedCalls(summaries).flat();
  if (repeats.length === 0) return sum;
  const toolBreakdown = { ...sum.toolBreakdown };
  for (const { toolName } of repeats) toolBreakdown[toolName] -= 1;
  return {
    ...sum,
    toolCallCount: sum.toolCallCount - repeats.length,
    toolBreakdown,
    bashCommandCount: sum.bashCommandCount - repeats.filter((e) => e.toolName === 'Bash').length,
  };
}

/**
 * Each top-level file an older build saved, as one more writer: what it holds
 * beyond the writer files. An older build saves on top of what it read, and
 * the writers may have saved more since. A call is the older build's when no
 * writer file holds it. Cost has no per-call split, so a file's cost loses the
 * whole of every writer it may hold. Projections hold only what writer files
 * and their captures hold, so they are skipped. Pass writer files only, never
 * an earlier capture. An older build saves an all-zero ledger once a real
 * report replaced its estimates, and retraction is a fact about the session,
 * so that file carries it.
 */
export function captureLegacyIndex(
  index: readonly IndexFile[],
  writers: readonly WriterContribution[],
): WriterContribution[] {
  return index
    .filter((f) => !f.isProjection)
    .map(({ summary }) => {
      const held = writers.filter((w) => mayHold(summary, w.summary));
      const left =
        held.length === 0
          ? summary
          : subtractSummaries(summary, foldWriterContributions(held as [WriterContribution]));
      return { summary: withTimelineCalls(left), retracted: savedRetraction(summary) };
    });
}

/**
 * Whether `file` can hold any of `writer`. Merges keep the earliest start and
 * the latest end, so a file holding some of a writer spans that writer's start.
 * A call both hold without that is one call two processes drained, which the
 * fold counts once.
 */
function mayHold(file: FullSessionSummary, writer: FullSessionSummary): boolean {
  const start = writer.startTime;
  return !(start > 0 && (file.startTime > start || (file.endTime > 0 && file.endTime < start)));
}

/** An older build max-merges call counts but unions timelines, so its timeline can name more. */
function withTimelineCalls(s: FullSessionSummary): FullSessionSummary {
  const named = new Map<string, number>();
  for (const { toolName } of s.timeline ?? []) named.set(toolName, (named.get(toolName) ?? 0) + 1);
  const toolBreakdown = { ...s.toolBreakdown };
  for (const [name, n] of named) toolBreakdown[name] = Math.max(toolBreakdown[name] ?? 0, n);
  return {
    ...s,
    toolCallCount: Math.max(s.toolCallCount, s.timeline?.length ?? 0),
    toolBreakdown,
    bashCommandCount: Math.max(s.bashCommandCount, named.get('Bash') ?? 0),
  };
}

function savedRetraction({ byteEstimates: ledger }: FullSessionSummary): boolean {
  return (
    ledger !== undefined &&
    ledger.costUsd === 0 &&
    ledger.inputTokens === 0 &&
    ledger.outputTokens === 0
  );
}

function foldedToolSuccessRate(inWriteOrder: readonly FullSessionSummary[]): number | null {
  const rated = inWriteOrder.flatMap((s) =>
    s.toolSuccessRate === null ? [] : [{ s, rate: s.toolSuccessRate }],
  );
  const repeats = repeatedCalls(rated.map(({ s }) => s));
  let calls = 0;
  let successes = 0;
  rated.forEach(({ s, rate }, i) => {
    calls += s.toolCallCount - repeats[i].length;
    successes += Math.round(rate * s.toolCallCount) - repeats[i].filter((e) => e.success).length;
  });
  return calls > 0 ? successes / calls : null;
}

/** Each summary's timeline entries that an earlier summary's timeline already holds. */
function repeatedCalls(summaries: readonly FullSessionSummary[]): ReplayTimelineEntry[][] {
  const seen = callIndex();
  return summaries.map((s) => {
    const calls = s.timeline ?? [];
    const repeats = calls.filter(seen.has);
    for (const e of calls) seen.add(e);
    return repeats;
  });
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
  const legacy = [...files.legacyCaptures, ...captureLegacyIndex(index, files.writers)];
  const parts = legacy.length > 0 ? [...files.writers, combineCaptures(legacy)] : files.writers;
  return {
    summary: foldWriterContributions(parts as [WriterContribution]),
    retracted: parts.some((p) => p.retracted),
  };
}

/**
 * Captures combine as index files do. Captures that share a call are views of
 * one history, each taken later, so they max-merge. An older build's own file
 * beside the pre-upgrade index shares none and adds.
 */
function combineCaptures(captures: readonly WriterContribution[]): WriterContribution {
  return {
    summary: combineSessionFiles(captures.map((c) => c.summary)),
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
