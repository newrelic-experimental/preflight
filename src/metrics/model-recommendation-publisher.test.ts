import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRecommendationConfidence, ModelRecommendationReport } from './trend-analyzer.js';
import { publishModelRecommendation } from './model-recommendation-publisher.js';

let storagePath: string;

beforeEach(() => {
  storagePath = mkdtempSync(join(tmpdir(), 'nr-rec-publish-'));
});

afterEach(() => {
  rmSync(storagePath, { recursive: true, force: true });
});

function analyzerReturning(
  confidence: ModelRecommendationConfidence,
  recommendedModel: string | null,
  generatedAt = 1_000,
) {
  const report: ModelRecommendationReport = {
    ranked: [
      {
        model: 'model-a',
        sessionCount: 25,
        avgCostUsd: 0.04,
        avgEfficiencyScore: 0.82,
        avgTaskSuccessRate: 0.95,
      },
      {
        model: 'model-b',
        sessionCount: 12,
        avgCostUsd: 0.08,
        avgEfficiencyScore: 0.7,
        avgTaskSuccessRate: 0.9,
      },
    ],
    recommendedModel,
    confidence,
    byOutcome: [],
    generatedAt,
  };
  return { rankModelsByOutcome: () => report };
}

const file = () => join(storagePath, 'model-recommendation.json');

describe('publishModelRecommendation', () => {
  it('writes the verdict under the configured storage path when confidence is high', () => {
    publishModelRecommendation(analyzerReturning('high', 'model-a'), storagePath);

    const published = JSON.parse(readFileSync(file(), 'utf8'));
    expect(published).toMatchObject({
      schemaVersion: 1,
      recommendedModel: 'model-a',
      confidence: 'high',
      generatedAt: 1_000,
    });
    expect(published.basedOn.ranked.map((m: { model: string }) => m.model)).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it.each<ModelRecommendationConfidence>(['medium', 'low', 'insufficient_data'])(
    'writes nothing when confidence is %s',
    (confidence) => {
      publishModelRecommendation(analyzerReturning(confidence, 'model-a'), storagePath);
      expect(existsSync(file())).toBe(false);
    },
  );

  it('removes a previously published file when confidence drops', () => {
    publishModelRecommendation(analyzerReturning('high', 'model-a'), storagePath);
    expect(existsSync(file())).toBe(true);

    publishModelRecommendation(analyzerReturning('medium', 'model-a'), storagePath);
    expect(existsSync(file())).toBe(false);
  });

  it('leaves the file untouched when the verdict is unchanged', () => {
    publishModelRecommendation(analyzerReturning('high', 'model-a', 1_000), storagePath);
    const first = readFileSync(file(), 'utf8');

    publishModelRecommendation(analyzerReturning('high', 'model-a', 9_000), storagePath);
    expect(readFileSync(file(), 'utf8')).toBe(first);
  });

  it('replaces the file when the recommended model changes', () => {
    publishModelRecommendation(analyzerReturning('high', 'model-a', 1_000), storagePath);
    publishModelRecommendation(analyzerReturning('high', 'model-b', 2_000), storagePath);

    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({
      recommendedModel: 'model-b',
      generatedAt: 2_000,
    });
  });

  it('leaves no temp files behind', () => {
    publishModelRecommendation(analyzerReturning('high', 'model-a'), storagePath);
    expect(readdirSync(storagePath)).toEqual(['model-recommendation.json']);
  });

  it('does not throw when the storage path does not exist', () => {
    const missing = join(storagePath, 'nope', 'deeper');
    expect(() =>
      publishModelRecommendation(analyzerReturning('high', 'model-a'), missing),
    ).not.toThrow();
    expect(existsSync(join(missing, 'model-recommendation.json'))).toBe(true);
  });
});
