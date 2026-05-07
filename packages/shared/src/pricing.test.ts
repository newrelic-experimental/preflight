import type { TokenUsage } from './tokens.js';
import { calculateCost, resolveModelPricing, initPricing, loadCustomPricing } from './pricing.js';
import { DEFAULT_PRICING_TABLE } from './pricing-data.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Helper: create a TokenUsage with sane defaults
function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  // Reset to built-in table before each test
  initPricing(null);
});

// ---------------------------------------------------------------------------
// 1. calculateCost for claude-sonnet-4 with known tokens
// ---------------------------------------------------------------------------
describe('calculateCost', () => {
  it('computes correct costs for claude-sonnet-4 with known tokens', () => {
    const cost = calculateCost(
      'claude-sonnet-4-20250514',
      usage({ inputTokens: 1000, outputTokens: 500, thinkingTokens: 200 }),
    );

    // input: 1000 * 3 / 1_000_000 = 0.003
    expect(cost.inputUsd).toBeCloseTo(0.003, 6);
    // output: 500 * 15 / 1_000_000 = 0.0075
    expect(cost.outputUsd).toBeCloseTo(0.0075, 6);
    // thinking: 200 * 15 / 1_000_000 = 0.003
    expect(cost.thinkingUsd).toBeCloseTo(0.003, 6);
    expect(cost.cacheReadUsd).toBe(0);
    expect(cost.cacheCreationUsd).toBe(0);
    expect(cost.totalUsd).toBeCloseTo(0.0135, 6);
  });

  // ---------------------------------------------------------------------------
  // 2. calculateCost for gemini-2.5-flash with thinking tokens
  // ---------------------------------------------------------------------------
  it('computes correct costs for gemini-2.5-flash including thinking tokens', () => {
    const cost = calculateCost(
      'gemini-2.5-flash',
      usage({ inputTokens: 10_000, outputTokens: 2_000, thinkingTokens: 5_000 }),
    );

    // gemini-2.5-flash (May 2026): flat pricing, no tiers
    // input: 10000 * 0.30 / 1_000_000 = 0.003
    expect(cost.inputUsd).toBeCloseTo(0.003, 6);
    // output: 2000 * 2.50 / 1_000_000 = 0.005
    expect(cost.outputUsd).toBeCloseTo(0.005, 6);
    // thinking: 5000 * 2.50 / 1_000_000 = 0.0125
    expect(cost.thinkingUsd).toBeCloseTo(0.0125, 6);
    expect(cost.totalUsd).toBeCloseTo(0.003 + 0.005 + 0.0125, 6);
  });

  // ---------------------------------------------------------------------------
  // 3. Cache cost calculation
  // ---------------------------------------------------------------------------
  it('calculates cache read at discount, cache creation at premium, and savings', () => {
    const cost = calculateCost(
      'claude-sonnet-4-20250514',
      usage({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheCreationTokens: 200_000,
      }),
    );

    // cacheRead: 500_000 * 0.30 / 1_000_000 = 0.15
    expect(cost.cacheReadUsd).toBeCloseTo(0.15, 6);
    // cacheCreation: 200_000 * 3.75 / 1_000_000 = 0.75
    expect(cost.cacheCreationUsd).toBeCloseTo(0.75, 6);
    // savings: 500_000 * (3.0 - 0.30) / 1_000_000 = 1.35
    expect(cost.savingsFromCacheUsd).toBeCloseTo(1.35, 6);
  });

  // ---------------------------------------------------------------------------
  // 7. Unknown model returns all-zero breakdown
  // ---------------------------------------------------------------------------
  it('returns all-zero breakdown for unknown model', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cost = calculateCost('totally-unknown-model', usage({ inputTokens: 1000 }));

    expect(cost.inputUsd).toBe(0);
    expect(cost.outputUsd).toBe(0);
    expect(cost.thinkingUsd).toBe(0);
    expect(cost.cacheReadUsd).toBe(0);
    expect(cost.cacheCreationUsd).toBe(0);
    expect(cost.totalUsd).toBe(0);
    expect(cost.savingsFromCacheUsd).toBe(0);

    // Verify a warning was logged
    expect(stderrSpy).toHaveBeenCalled();
    const logOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(logOutput).toContain('Unknown model');

    stderrSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 10. All costs non-negative, totalUsd equals sum of components
  // ---------------------------------------------------------------------------
  it('produces non-negative costs where totalUsd equals sum of components', () => {
    for (const model of Object.keys(DEFAULT_PRICING_TABLE)) {
      const cost = calculateCost(
        model,
        usage({
          inputTokens: 50_000,
          outputTokens: 10_000,
          thinkingTokens: 5_000,
          cacheReadTokens: 3_000,
          cacheCreationTokens: 1_000,
        }),
      );

      expect(cost.inputUsd).toBeGreaterThanOrEqual(0);
      expect(cost.outputUsd).toBeGreaterThanOrEqual(0);
      expect(cost.thinkingUsd).toBeGreaterThanOrEqual(0);
      expect(cost.cacheReadUsd).toBeGreaterThanOrEqual(0);
      expect(cost.cacheCreationUsd).toBeGreaterThanOrEqual(0);
      expect(cost.totalUsd).toBeGreaterThanOrEqual(0);
      expect(cost.savingsFromCacheUsd).toBeGreaterThanOrEqual(0);

      const sum =
        cost.inputUsd +
        cost.outputUsd +
        cost.thinkingUsd +
        cost.cacheReadUsd +
        cost.cacheCreationUsd;
      expect(cost.totalUsd).toBeCloseTo(sum, 10);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Gemini tiered pricing (>200k tokens uses higher rates)
  // ---------------------------------------------------------------------------
  it('applies tiered pricing when input tokens exceed threshold', () => {
    // Below threshold
    const costBelow = calculateCost(
      'gemini-2.5-pro',
      usage({ inputTokens: 100_000, outputTokens: 10_000 }),
    );
    // input: 100_000 * 1.25 / 1_000_000 = 0.125
    expect(costBelow.inputUsd).toBeCloseTo(0.125, 6);
    // output: 10_000 * 10 / 1_000_000 = 0.1
    expect(costBelow.outputUsd).toBeCloseTo(0.1, 6);

    // Above threshold (>200k)
    const costAbove = calculateCost(
      'gemini-2.5-pro',
      usage({ inputTokens: 300_000, outputTokens: 10_000 }),
    );
    // input: 300_000 * 2.50 / 1_000_000 = 0.75
    expect(costAbove.inputUsd).toBeCloseTo(0.75, 6);
    // output: 10_000 * 15 / 1_000_000 = 0.15
    expect(costAbove.outputUsd).toBeCloseTo(0.15, 6);

    // Tiered rate should be higher
    expect(costAbove.inputUsd).toBeGreaterThan(costBelow.inputUsd);
    expect(costAbove.outputUsd).toBeGreaterThan(costBelow.outputUsd);
  });
});

// ---------------------------------------------------------------------------
// resolveModelPricing
// ---------------------------------------------------------------------------
describe('resolveModelPricing', () => {
  // 4. Exact match
  it('returns pricing for exact model name match', () => {
    const pricing = resolveModelPricing('claude-sonnet-4-20250514');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(3);
    expect(pricing!.outputPerMTok).toBe(15);
    expect(pricing!.contextWindow).toBe(200_000);
  });

  // 5. Prefix match
  it('resolves alias via prefix match', () => {
    const pricing = resolveModelPricing('claude-sonnet-4');
    expect(pricing).not.toBeNull();
    // Should resolve to the dated version's pricing
    expect(pricing!.inputPerMTok).toBe(3);
    expect(pricing!.outputPerMTok).toBe(15);
  });

  // 6. Unknown model
  it('returns null for unknown model', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const pricing = resolveModelPricing('completely-unknown-model-2099');
    expect(pricing).toBeNull();

    stderrSpy.mockRestore();
  });

  // 12. Exact match for current-gen dateless IDs; reverse prefix for legacy names
  it('resolves current-gen dateless model IDs via exact match', () => {
    // These IDs are now explicit keys in the table — exact match, not prefix match
    const opus = resolveModelPricing('claude-opus-4-7');
    expect(opus).not.toBeNull();
    expect(opus!.inputPerMTok).toBe(5);
    expect(opus!.outputPerMTok).toBe(25);

    const sonnet = resolveModelPricing('claude-sonnet-4-6');
    expect(sonnet).not.toBeNull();
    expect(sonnet!.inputPerMTok).toBe(3);
    expect(sonnet!.outputPerMTok).toBe(15);
  });

  it('resolves partial model names via reverse prefix match', () => {
    // claude-haiku-3-5 should match claude-haiku-3-5-20241022 (base: claude-haiku-3-5)
    const haiku = resolveModelPricing('claude-haiku-3-5');
    expect(haiku).not.toBeNull();
    expect(haiku!.inputPerMTok).toBe(0.8);
  });

  // 13. Reverse prefix does not match unrelated models
  it('does not false-match via reverse prefix on unrelated models', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const pricing = resolveModelPricing('claude-opus-5-1');
    expect(pricing).toBeNull();

    stderrSpy.mockRestore();
  });

  // 14. Forward prefix must not match a longer key that diverges at a non-digit suffix
  it('does not match gemini-2.5-flash-lite for query gemini-2.5-flash', () => {
    // "gemini-2.5-flash" is an exact key, so this tests exact match — but the
    // important invariant is that "-lite" suffix does NOT satisfy the /-\d/ guard,
    // meaning even if the exact key were absent the algorithm would not wrong-match.
    const flash = resolveModelPricing('gemini-2.5-flash');
    const flashLite = resolveModelPricing('gemini-2.5-flash-lite');

    expect(flash).not.toBeNull();
    expect(flashLite).not.toBeNull();
    // They must resolve to different pricing entries
    expect(flash!.inputPerMTok).not.toBe(flashLite!.inputPerMTok);
    // flash = $0.30/MTok input; flash-lite = $0.10/MTok input
    expect(flash!.inputPerMTok).toBe(0.3);
    expect(flashLite!.inputPerMTok).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Custom pricing file
// ---------------------------------------------------------------------------
describe('custom pricing file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pricing-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 8. Custom pricing overrides specific models
  it('overrides specified models while leaving others intact', () => {
    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'claude-sonnet-4-20250514': {
          inputPerMTok: 5,
          outputPerMTok: 20,
          contextWindow: 200_000,
        },
      }),
    );

    initPricing(customFile);

    // Overridden model
    const sonnet = resolveModelPricing('claude-sonnet-4-20250514');
    expect(sonnet!.inputPerMTok).toBe(5);
    expect(sonnet!.outputPerMTok).toBe(20);

    // Non-overridden model remains unchanged
    const opus = resolveModelPricing('claude-opus-4-20250514');
    expect(opus!.inputPerMTok).toBe(15);
    expect(opus!.outputPerMTok).toBe(75);
  });

  // S-01: path traversal / extension validation
  it('rejects paths without a .json extension', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = loadCustomPricing('/etc/passwd');
    expect(result).toBeNull();
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('.json extension');

    stderrSpy.mockRestore();
  });

  it('rejects .txt files', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = loadCustomPricing(join(tmpDir, 'pricing.txt'));
    expect(result).toBeNull();
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('.json extension');

    stderrSpy.mockRestore();
  });

  it('accepts a .JSON extension (case-insensitive)', () => {
    const customFile = join(tmpDir, 'pricing.JSON');
    writeFileSync(customFile, JSON.stringify({ 'test-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100000 } }));
    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['test-model'].inputPerMTok).toBe(1);
  });

  it('resolves relative paths before reading (logs the absolute path on error)', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    loadCustomPricing('nonexistent-relative.json');
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    // The logged path should be absolute (starts with /)
    expect(output).toMatch(/\/.*nonexistent-relative\.json/);

    stderrSpy.mockRestore();
  });

  // S-02: per-entry validation of rate fields
  it('skips entries with negative inputPerMTok and keeps valid ones', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(customFile, JSON.stringify({
      'bad-model': { inputPerMTok: -999, outputPerMTok: 5, contextWindow: 100_000 },
      'good-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
    }));

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['bad-model']).toBeUndefined();
    expect(result!['good-model']).toBeDefined();
    expect(result!['good-model'].inputPerMTok).toBe(1);

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('invalid inputPerMTok');
    stderrSpy.mockRestore();
  });

  it('skips entries with non-numeric outputPerMTok', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(customFile, JSON.stringify({
      'exploit-model': { inputPerMTok: 1, outputPerMTok: 'EXPLOIT', contextWindow: 100_000 },
    }));

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['exploit-model']).toBeUndefined();

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('invalid outputPerMTok');
    stderrSpy.mockRestore();
  });

  it('skips entries with NaN or Infinity rate values', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'custom-pricing.json');
    // JSON.parse turns these into the numbers NaN/Infinity after eval — but
    // JSON spec only supports numeric literals, so embed via the string form
    // that JSON.parse turns into a regular number to test the validator.
    // Instead test via the JS object written programmatically:
    const content = '{"nan-model":{"inputPerMTok":null,"outputPerMTok":2,"contextWindow":100000}}';
    writeFileSync(customFile, content);

    const result = loadCustomPricing(customFile);
    expect(result!['nan-model']).toBeUndefined();
    stderrSpy.mockRestore();
  });

  it('skips entries with missing or invalid contextWindow', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(customFile, JSON.stringify({
      'no-ctx': { inputPerMTok: 1, outputPerMTok: 2 },
      'zero-ctx': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 0 },
    }));

    const result = loadCustomPricing(customFile);
    expect(result!['no-ctx']).toBeUndefined();
    expect(result!['zero-ctx']).toBeUndefined();
    stderrSpy.mockRestore();
  });

  it('skips entries with invalid optional rate fields', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(customFile, JSON.stringify({
      'bad-optional': {
        inputPerMTok: 1,
        outputPerMTok: 2,
        contextWindow: 100_000,
        cacheReadPerMTok: -1,
      },
    }));

    const result = loadCustomPricing(customFile);
    expect(result!['bad-optional']).toBeUndefined();
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('invalid cacheReadPerMTok');
    stderrSpy.mockRestore();
  });

  it('accepts valid entries with all optional fields present', () => {
    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(customFile, JSON.stringify({
      'full-model': {
        inputPerMTok: 1,
        outputPerMTok: 2,
        thinkingPerMTok: 3,
        cacheReadPerMTok: 0.5,
        cacheCreationPerMTok: 1.5,
        contextWindow: 200_000,
        tierThreshold: 128_000,
        tierInputPerMTok: 2,
        tierOutputPerMTok: 4,
        tierThinkingPerMTok: 6,
      },
    }));

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['full-model']).toBeDefined();
    expect(result!['full-model'].tierThreshold).toBe(128_000);
  });

  // 9. Invalid JSON falls back to built-in
  it('falls back to built-in table when custom file has invalid JSON', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const customFile = join(tmpDir, 'bad-pricing.json');
    writeFileSync(customFile, '{ invalid json !!!');

    initPricing(customFile);

    // Should still resolve using built-in table
    const pricing = resolveModelPricing('claude-sonnet-4-20250514');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(3);

    // Verify a warning was logged
    expect(stderrSpy).toHaveBeenCalled();
    const logOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(logOutput).toContain('Failed to load custom pricing file');

    stderrSpy.mockRestore();
  });
});
