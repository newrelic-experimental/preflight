import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '../shared/index.js';
import { isPidAlive } from '../storage/local-store.js';
import type { ModelOutcomeStats, TrendAnalyzer } from './trend-analyzer.js';

const logger = createLogger('model-recommendation-publisher');

export const MODEL_RECOMMENDATION_FILENAME = 'model-recommendation.json';
export const MODEL_RECOMMENDATION_SCHEMA_VERSION = 1;
const FIRST_PUBLISH_DELAY_MS = 10_000;
const PUBLISH_INTERVAL_MS = 60 * 60 * 1000;
const TEMP_FILE_PREFIX = `${MODEL_RECOMMENDATION_FILENAME}.tmp-`;
const STALE_TEMP_AGE_MS = 60_000;

export interface PublishedModelRecommendation {
  readonly schemaVersion: typeof MODEL_RECOMMENDATION_SCHEMA_VERSION;
  readonly recommendedModel: string;
  readonly confidence: 'high';
  readonly basedOn: { readonly ranked: readonly ModelOutcomeStats[] };
  readonly generatedAt: number;
}

type Analyzer = Pick<TrendAnalyzer, 'rankModelsByOutcome'>;

function readPublished(path: string): PublishedModelRecommendation | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PublishedModelRecommendation;
  } catch {
    return null;
  }
}

function sameVerdict(a: PublishedModelRecommendation, b: PublishedModelRecommendation): boolean {
  return JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
}

/**
 * Remove temp files a crashed publish left between writeFileSync and
 * renameSync. A temp file is kept only while its writer pid is alive and the
 * file is under a minute old, so a concurrent writer's file survives.
 */
function removeStaleTempFiles(storagePath: string): void {
  const now = Date.now();
  let names: string[];
  try {
    names = readdirSync(storagePath);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_FILE_PREFIX)) continue;
    const path = join(storagePath, name);
    try {
      const ageMs = now - statSync(path).mtimeMs;
      const writerAlive = isPidAlive(Number(name.slice(TEMP_FILE_PREFIX.length)));
      if (writerAlive && ageMs <= STALE_TEMP_AGE_MS) continue;
      rmSync(path, { force: true });
    } catch {
      // Another process removed the file first.
    }
  }
}

/**
 * Publish the overall model verdict for consumers that cannot call an MCP
 * tool (a SessionStart hook reads this file directly). Reuses the same
 * `confidence === 'high'` gate as RecommendationEngine. Below that gate the
 * file is removed rather than marked stale, so a reader never acts on a
 * verdict the data no longer supports. An unchanged verdict is not rewritten.
 */
export function publishModelRecommendation(analyzer: Analyzer, storagePath: string): void {
  const path = join(storagePath, MODEL_RECOMMENDATION_FILENAME);
  removeStaleTempFiles(storagePath);
  try {
    const report = analyzer.rankModelsByOutcome();
    if (report.confidence !== 'high' || report.recommendedModel === null) {
      rmSync(path, { force: true });
      return;
    }

    const next: PublishedModelRecommendation = {
      schemaVersion: MODEL_RECOMMENDATION_SCHEMA_VERSION,
      recommendedModel: report.recommendedModel,
      confidence: 'high',
      basedOn: { ranked: report.ranked },
      generatedAt: report.generatedAt,
    };
    const existing = readPublished(path);
    if (existing && sameVerdict(existing, next)) return;

    mkdirSync(storagePath, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  } catch (err) {
    logger.warn('Failed to publish model recommendation', { error: String(err) });
  }
}

/**
 * Publish once shortly after startup, then hourly. The first publish is
 * deferred so the session-list scan does not delay the dashboard becoming
 * ready. Both timers are unref'd. The returned function cancels both.
 */
export function startModelRecommendationPublisher(
  analyzer: Analyzer,
  storagePath: string,
): () => void {
  const publish = () => publishModelRecommendation(analyzer, storagePath);
  const first = setTimeout(publish, FIRST_PUBLISH_DELAY_MS);
  first.unref?.();
  const interval = setInterval(publish, PUBLISH_INTERVAL_MS);
  interval.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
