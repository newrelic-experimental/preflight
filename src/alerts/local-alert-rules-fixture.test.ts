import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLocalAlertRules } from './local-alert-rule.js';

// __dirname is provided by ts-jest — no ESM declaration needed (matches alerts.test.ts pattern)
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('examples/local-alert-rules.json', () => {
  // Resolve relative to the source file (src/alerts) → repo root → examples/.
  const fixturePath = resolve(__dirname, '..', '..', 'examples', 'local-alert-rules.json');

  it('parses cleanly with 8 valid rules and 0 invalid', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const json = JSON.parse(raw) as unknown;
    const result = parseLocalAlertRules(json);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(8);
  });

  it('contains the expected rule ids', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const json = JSON.parse(raw) as unknown;
    const result = parseLocalAlertRules(json);
    const ids = new Set(result.valid.map((r) => r.id));
    expect(ids).toEqual(new Set([
      'session-cost-spike',
      'low-efficiency-score',
      'stuck-loop-rate',
      'anti-pattern-rate',
      'session-cost-budget',
      'bash-latency-degradation',
      'daily-budget-warn',
      'weekly-budget-warn',
    ]));
  });

  it('the stuck-loop rule opts into the os channel (it is the only one)', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const json = JSON.parse(raw) as unknown;
    const result = parseLocalAlertRules(json);
    const osRules = result.valid.filter((r) => r.channels.includes('os'));
    expect(osRules.map((r) => r.id)).toEqual(['stuck-loop-rate']);
  });
});
