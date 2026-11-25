import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ByteEstimateLedger } from '../metrics/cost-tracker.js';
import {
  addSummaries,
  byWriteOrder,
  combineSessionFiles,
  deserializeFullSessionSummary,
  exactTotalsOf,
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
  index: readonly IndexFile[],
  files: WriterFiles,
): FullSessionSummary {
  const legacy = [...files.legacyCaptures, ...captureLegacyIndex(index, files.writers)];
  const parts = legacy.length > 0 ? [...files.writers, combineCaptures(legacy)] : files.writers;
  return foldWriterContributions(parts as [WriterContribution]);
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
