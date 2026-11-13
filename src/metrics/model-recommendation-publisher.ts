import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '../shared/index.js';
import type { ModelOutcomeStats, TrendAnalyzer } from './trend-analyzer.js';

const logger = createLogger('model-recommendation-publisher');

export const MODEL_RECOMMENDATION_FILENAME = 'model-recommendation.json';
export const MODEL_RECOMMENDATION_SCHEMA_VERSION = 1;
const PUBLISH_INTERVAL_MS = 60 * 60 * 1000;

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
 * Publish the overall model verdict for consumers that cannot call an MCP
 * tool (a SessionStart hook reads this file directly). Reuses the same
 * `confidence === 'high'` gate as RecommendationEngine. Below that gate the
 * file is removed rather than marked stale, so a reader never acts on a
 * verdict the data no longer supports. An unchanged verdict is not rewritten.
 */
export function publishModelRecommendation(analyzer: Analyzer, storagePath: string): void {
  const path = join(storagePath, MODEL_RECOMMENDATION_FILENAME);
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

/** Publish once immediately, then hourly. */
export function startModelRecommendationPublisher(
  analyzer: Analyzer,
  storagePath: string,
): NodeJS.Timeout {
  publishModelRecommendation(analyzer, storagePath);
  const interval = setInterval(
    () => publishModelRecommendation(analyzer, storagePath),
    PUBLISH_INTERVAL_MS,
  );
  interval.unref?.();
  return interval;
}
