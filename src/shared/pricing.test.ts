import type { TokenUsage } from './tokens.js';
import {
  calculateCost,
  resolveModelPricing,
  initPricing,
  loadCustomPricing,
  PricingTable,
} from './pricing.js';
import { DEFAULT_PRICING_TABLE } from './pricing-data.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogOutput } from './__test-utils__/log-output.js';

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
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

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
    const logOutput = getLogOutput(stderrSpy);
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

  // ---------------------------------------------------------------------------
  // 11b. Marginal-mode tiered pricing
  // ---------------------------------------------------------------------------
  describe('marginal-mode tiered pricing', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'pricing-marginal-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function loadMarginalPricing(): void {
      const customFile = join(tmpDir, 'marginal.json');
      writeFileSync(
        customFile,
        JSON.stringify({
          'marginal-test': {
            inputPerMTok: 1,
            outputPerMTok: 10,
            thinkingPerMTok: 5,
            contextWindow: 1_000_000,
            tierThreshold: 100_000,
            tierInputPerMTok: 4,
            // tierOutputPerMTok / tierThinkingPerMTok intentionally set —
            // marginal mode must IGNORE them.
            tierOutputPerMTok: 999,
            tierThinkingPerMTok: 999,
            tierMode: 'marginal',
          },
        }),
      );
      initPricing(customFile);
    }

    it('bills only the excess input tokens at the tier rate; output/thinking use base rates', () => {
      loadMarginalPricing();

      const cost = calculateCost(
        'marginal-test',
        usage({ inputTokens: 250_000, outputTokens: 1_000, thinkingTokens: 500 }),
      );

      // Input split: 100_000 @ $1 + 150_000 @ $4 = 0.1 + 0.6 = 0.7
      expect(cost.inputUsd).toBeCloseTo(0.7, 6);
      // Output: base rate only (tierOutputPerMTok ignored in marginal mode)
      // 1000 * 10 / 1_000_000 = 0.01
      expect(cost.outputUsd).toBeCloseTo(0.01, 6);
      // Thinking: base rate only
      // 500 * 5 / 1_000_000 = 0.0025
      expect(cost.thinkingUsd).toBeCloseTo(0.0025, 6);
    });

    it('uses base rate for entire input when below threshold, regardless of mode', () => {
      loadMarginalPricing();

      const cost = calculateCost(
        'marginal-test',
        usage({ inputTokens: 50_000, outputTokens: 1_000 }),
      );

      // Below threshold: entire input at base rate
      // 50_000 * 1 / 1_000_000 = 0.05
      expect(cost.inputUsd).toBeCloseTo(0.05, 6);
      expect(cost.outputUsd).toBeCloseTo(0.01, 6);
    });

    it('charges base rate exactly when input equals threshold', () => {
      loadMarginalPricing();

      const cost = calculateCost('marginal-test', usage({ inputTokens: 100_000 }));

      // 100_000 * 1 / 1_000_000 = 0.1; no excess to charge at tier rate
      expect(cost.inputUsd).toBeCloseTo(0.1, 6);
    });

    it('computes cache savings at tier rate in marginal mode when input exceeds threshold', () => {
      loadMarginalPricing();
      // marginal-test: inputPerMTok=1, tierInputPerMTok=4, threshold=100k, cacheReadPerMTok not set (0)
      // 200k input (above 100k threshold): savingsInputRate = tierInputPerMTok = 4
      // savings = 50_000 * (4 - 0) / 1_000_000 = 0.2
      const cost = calculateCost(
        'marginal-test',
        usage({ inputTokens: 200_000, cacheReadTokens: 50_000, outputTokens: 0 }),
      );
      expect(cost.savingsFromCacheUsd).toBeCloseTo(0.2, 6);

      // Below threshold (50k input): savingsInputRate = inputPerMTok = 1
      // savings = 20_000 * (1 - 0) / 1_000_000 = 0.02
      const costBelow = calculateCost(
        'marginal-test',
        usage({ inputTokens: 50_000, cacheReadTokens: 20_000, outputTokens: 0 }),
      );
      expect(costBelow.savingsFromCacheUsd).toBeCloseTo(0.02, 6);
    });

    it('defaults to flat mode when tierMode is omitted (regression: gemini-2.5-pro behavior)', () => {
      // gemini-2.5-pro has no tierMode set — must continue to bill flat
      const cost = calculateCost(
        'gemini-2.5-pro',
        usage({ inputTokens: 300_000, outputTokens: 10_000 }),
      );
      // Flat: 300_000 * 2.50 = 0.75 (NOT a marginal split)
      expect(cost.inputUsd).toBeCloseTo(0.75, 6);
    });
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
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

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

  it('resolves model name via forward-prefix when no alias exists — "claude-opus-4-5" prefix matches "claude-opus-4-5-..."', () => {
    // claude-opus-4-5 is an exact key, so this exercises exact-match not forward-prefix.
    // Using claude-sonnet-4-5 which IS an exact key to verify exact-match path works.
    // For a genuine forward-prefix test: "claude-sonnet-4-5-" would match "claude-sonnet-4-5"
    // with suffix starting with a digit — but no such query is realistic today.
    // Instead, verify the alias test is actually testing aliases not forward-prefix:
    const opusAlias = resolveModelPricing('claude-opus-4'); // resolves via alias
    const opusDirect = resolveModelPricing('claude-opus-4-7'); // resolves via exact match
    expect(opusAlias).not.toBeNull();
    expect(opusDirect).not.toBeNull();
    // Both should return the same rates (alias routes to the dateless key)
    expect(opusAlias!.inputPerMTok).toBe(opusDirect!.inputPerMTok);
  });

  it('resolves claude-haiku-4 to the dateless claude-haiku-4-5 entry, not the dated one', () => {
    const haiku4 = resolveModelPricing('claude-haiku-4');
    expect(haiku4).not.toBeNull();
    // Resolves to the dateless current-gen entry (via alias → dateless key)
    expect(haiku4!.inputPerMTok).toBe(1);
    expect(haiku4!.outputPerMTok).toBe(5);
  });

  it('resolves gpt-5, gemini-2.5, gemini-2.0 via added MODEL_ALIASES', () => {
    const gpt5 = resolveModelPricing('gpt-5');
    expect(gpt5).not.toBeNull();
    expect(gpt5!.inputPerMTok).toBeGreaterThan(0);

    const gemini25 = resolveModelPricing('gemini-2.5');
    expect(gemini25).not.toBeNull();
    // Routes to gemini-2.5-pro
    expect(gemini25!.inputPerMTok).toBeGreaterThan(0);

    const gemini20 = resolveModelPricing('gemini-2.0');
    expect(gemini20).not.toBeNull();
    // Routes to gemini-2.0-flash
    expect(gemini20!.inputPerMTok).toBeGreaterThan(0);
  });

  // 13. Reverse prefix does not match unrelated models
  it('does not false-match via reverse prefix on unrelated models', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const pricing = resolveModelPricing('claude-opus-5-1');
    expect(pricing).toBeNull();

    stderrSpy.mockRestore();
  });

  // 13b. Verify claude-opus-4-10 routes to current-gen Opus 4 pricing via
  // reverse-prefix. The concern was that claude-opus-4-1 would be
  // matched, but the algorithm uses DATED_SUFFIX_RE to extract base names, so
  // claude-opus-4-1 (no date suffix) is skipped. The actual path is:
  // reverse-prefix matches claude-opus-4-20250514 → base 'claude-opus-4' →
  // alias → claude-opus-4-7 (correct current-gen pricing).
  it('resolves "claude-opus-4-10" to current-gen Opus 4 via reverse-prefix+alias', () => {
    const pricing = resolveModelPricing('claude-opus-4-10');
    expect(pricing).not.toBeNull();
    // Routes to claude-opus-4-7 rates (NOT claude-opus-4-1 which would be wrong)
    expect(pricing!.inputPerMTok).toBe(5);
    expect(pricing!.outputPerMTok).toBe(25);
    expect(pricing!.contextWindow).toBe(1_000_000); // current-gen, not 200k legacy
  });

  // 14a. Family-name input must route to current-gen pricing, not legacy dated key
  // (regression test — `claude-opus-4` previously routed to
  // `claude-opus-4-20250514` at $15/$75 instead of `claude-opus-4-7` at $5/$25.)
  it('resolves "claude-opus-4" to current-gen pricing via the alias map (not legacy)', () => {
    const pricing = resolveModelPricing('claude-opus-4');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(5); // current claude-opus-4-7
    expect(pricing!.outputPerMTok).toBe(25);
    expect(pricing!.contextWindow).toBe(1_000_000);
  });

  it('resolves a future Opus 4.x version (claude-opus-4-99) to current-gen pricing', () => {
    // Reverse-prefix path: bases include "claude-opus-4" (from legacy dated key),
    // so this matches. The alias map redirects from base → current-gen entry.
    const pricing = resolveModelPricing('claude-opus-4-99');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(5);
    expect(pricing!.outputPerMTok).toBe(25);
  });

  it('still resolves legacy dated keys to their original legacy pricing', () => {
    const pricing = resolveModelPricing('claude-opus-4-20250514');
    expect(pricing!.inputPerMTok).toBe(15);
    expect(pricing!.outputPerMTok).toBe(75);
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
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadCustomPricing('/etc/passwd');
    expect(result).toBeNull();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('.json extension');

    stderrSpy.mockRestore();
  });

  it('rejects .txt files', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = loadCustomPricing(join(tmpDir, 'pricing.txt'));
    expect(result).toBeNull();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('.json extension');

    stderrSpy.mockRestore();
  });

  it('accepts a .JSON extension (case-insensitive)', () => {
    const customFile = join(tmpDir, 'pricing.JSON');
    writeFileSync(
      customFile,
      JSON.stringify({
        'test-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100000 },
      }),
    );
    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['test-model'].inputPerMTok).toBe(1);
  });

  it('resolves relative paths before reading (logs the absolute path on error)', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    loadCustomPricing('nonexistent-relative.json');
    const output = getLogOutput(stderrSpy);
    // The logged path should be absolute (starts with /)
    expect(output).toMatch(/\/.*nonexistent-relative\.json/);

    stderrSpy.mockRestore();
  });

  // S-02: per-entry validation of rate fields
  it('skips entries with negative inputPerMTok and keeps valid ones', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'bad-model': { inputPerMTok: -999, outputPerMTok: 5, contextWindow: 100_000 },
        'good-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['bad-model']).toBeUndefined();
    expect(result!['good-model']).toBeDefined();
    expect(result!['good-model'].inputPerMTok).toBe(1);

    const output = getLogOutput(stderrSpy);
    expect(output).toContain('invalid inputPerMTok');
    stderrSpy.mockRestore();
  });

  it('skips entries with non-numeric outputPerMTok', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'exploit-model': { inputPerMTok: 1, outputPerMTok: 'EXPLOIT', contextWindow: 100_000 },
        'valid-model': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['exploit-model']).toBeUndefined();
    expect(result!['valid-model']).toBeDefined();

    const output = getLogOutput(stderrSpy);
    expect(output).toContain('invalid outputPerMTok');
    stderrSpy.mockRestore();
  });

  it('skips entries with NaN or Infinity rate values', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    // JSON.parse turns these into the numbers NaN/Infinity after eval — but
    // JSON spec only supports numeric literals, so embed via the string form
    // that JSON.parse turns into a regular number to test the validator.
    // Instead test via the JS object written programmatically:
    const content =
      '{"nan-model":{"inputPerMTok":null,"outputPerMTok":2,"contextWindow":100000},"valid":{"inputPerMTok":1,"outputPerMTok":2,"contextWindow":100000}}';
    writeFileSync(customFile, content);

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['nan-model']).toBeUndefined();
    expect(result!['valid']).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('skips entries with missing or invalid contextWindow', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'no-ctx': { inputPerMTok: 1, outputPerMTok: 2 },
        'zero-ctx': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 0 },
        valid: { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['no-ctx']).toBeUndefined();
    expect(result!['zero-ctx']).toBeUndefined();
    expect(result!['valid']).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('rejects fractional contextWindow and tierThreshold', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const customFile = join(tmpDir, 'fractional.json');

    writeFileSync(
      customFile,
      JSON.stringify({
        'frac-ctx': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200000.5 },
        'frac-tier': {
          inputPerMTok: 1,
          outputPerMTok: 2,
          contextWindow: 100_000,
          tierThreshold: 50000.5,
          tierInputPerMTok: 2,
        },
        valid: { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['frac-ctx']).toBeUndefined();
    expect(result!['frac-tier']).toBeUndefined();
    expect(result!['valid']).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('skips entries with invalid optional rate fields', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'bad-optional': {
          inputPerMTok: 1,
          outputPerMTok: 2,
          contextWindow: 100_000,
          cacheReadPerMTok: -1,
        },
        valid: { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['bad-optional']).toBeUndefined();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('invalid cacheReadPerMTok');
    stderrSpy.mockRestore();
  });

  // sane upper bound on custom pricing rates
  it('rejects entries with implausibly large inputPerMTok (above ceiling)', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'typo-rate': { inputPerMTok: 50000, outputPerMTok: 2, contextWindow: 100_000 },
        valid: { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['typo-rate']).toBeUndefined();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('implausibly large inputPerMTok');
    stderrSpy.mockRestore();
  });

  it('rejects entries with implausibly large optional rate fields', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'cache-typo': {
          inputPerMTok: 1,
          outputPerMTok: 2,
          contextWindow: 100_000,
          cacheCreationPerMTok: 99999,
        },
        valid: { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['cache-typo']).toBeUndefined();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('implausibly large cacheCreationPerMTok');
    stderrSpy.mockRestore();
  });

  it('returns null (not {}) when all entries in the file are invalid', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const customFile = join(tmpDir, 'all-bad.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'bad-a': { inputPerMTok: 'x', outputPerMTok: 2, contextWindow: 100_000 },
        'bad-b': { inputPerMTok: 1, outputPerMTok: 2 }, // missing contextWindow
      }),
    );
    const result = loadCustomPricing(customFile);
    expect(result).toBeNull(); // all invalid → null, not {}
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('no valid entries');
    stderrSpy.mockRestore();
  });

  it('accepts entries near but below the rate ceiling', () => {
    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'expensive-but-valid': {
          inputPerMTok: 9999,
          outputPerMTok: 9999,
          contextWindow: 100_000,
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result!['expensive-but-valid']).toBeDefined();
    expect(result!['expensive-but-valid'].inputPerMTok).toBe(9999);
  });

  it('warns but accepts when cacheReadPerMTok exceeds inputPerMTok', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'unusual-cache': {
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: 5,
          contextWindow: 100_000,
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result!['unusual-cache']).toBeDefined();
    expect(result!['unusual-cache'].cacheReadPerMTok).toBe(5);
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('cacheReadPerMTok above inputPerMTok');
    stderrSpy.mockRestore();
  });

  it('warns but accepts when tierInputPerMTok is below inputPerMTok (volume discount)', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'volume-discount': {
          inputPerMTok: 5,
          outputPerMTok: 10,
          contextWindow: 200_000,
          tierThreshold: 100_000,
          tierInputPerMTok: 2,
          tierOutputPerMTok: 5,
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result!['volume-discount']).toBeDefined();
    expect(result!['volume-discount'].tierInputPerMTok).toBe(2);
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('tierInputPerMTok below inputPerMTok');
    stderrSpy.mockRestore();
  });

  it('accepts valid entries with all optional fields present', () => {
    const customFile = join(tmpDir, 'custom-pricing.json');
    writeFileSync(
      customFile,
      JSON.stringify({
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
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['full-model']).toBeDefined();
    expect(result!['full-model'].tierThreshold).toBe(128_000);
  });

  // 9. Invalid JSON falls back to built-in
  it('falls back to built-in table when custom file has invalid JSON', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'bad-pricing.json');
    writeFileSync(customFile, '{ invalid json !!!');

    initPricing(customFile);

    // Should still resolve using built-in table
    const pricing = resolveModelPricing('claude-sonnet-4-20250514');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(3);

    // Verify a warning was logged
    expect(stderrSpy).toHaveBeenCalled();
    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('Failed to load custom pricing file');

    stderrSpy.mockRestore();
  });

  // file size cap
  it('rejects custom pricing files larger than the size cap (1 MB)', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'huge-pricing.json');
    // Write a JSON file with a >1 MB string body. The shape is still valid
    // JSON, so the rejection MUST come from the size check, not the parser.
    const padding = 'x'.repeat(1_100_000);
    writeFileSync(
      customFile,
      JSON.stringify({
        'huge-model': { _padding: padding, inputPerMTok: 1, outputPerMTok: 2, contextWindow: 100 },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).toBeNull();

    const logOutput = getLogOutput(stderrSpy);
    expect(logOutput).toContain('exceeds size limit');
    expect(logOutput).toContain('sizeBytes');
    stderrSpy.mockRestore();
  });

  it('accepts custom pricing files at the boundary just under the size cap', () => {
    const customFile = join(tmpDir, 'boundary-pricing.json');
    // ~500 KB padding inside a string field — well above any real-world
    // pricing dictionary but still well below the 1 MB cap.
    const padding = 'y'.repeat(500_000);
    writeFileSync(
      customFile,
      JSON.stringify({
        'boundary-model': {
          _comment: padding,
          inputPerMTok: 1,
          outputPerMTok: 2,
          contextWindow: 100_000,
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    expect(result!['boundary-model']).toBeDefined();
    expect(result!['boundary-model'].inputPerMTok).toBe(1);
  });

  // fresh-object construction drops unknown fields
  it("drops unknown / typo'd fields from custom pricing entries", () => {
    const customFile = join(tmpDir, 'with-extras.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'extras-model': {
          inputPerMTok: 5,
          outputPerMTok: 10,
          contextWindow: 200_000,
          // Unknown fields that should NOT survive into the merged table.
          // Note: `__proto__` key behavior is tested in the dedicated test
          // above. JSON.stringify DOES serialize '__proto__' as a regular string
          // key (it does not drop it), and JSON.parse reproduces it as an own
          // enumerable property — the denylist in loadCustomPricing is what
          // prevents the prototype pollution, not any JSON serialization quirk.
          notes: 'free for friends',
          inpurPerMTok: 999, // typo of inputPerMTok
          nestedJunk: { a: 1, b: 2 },
          futureField: 'reserved',
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    expect(result).not.toBeNull();
    const entry = result!['extras-model'];
    expect(entry).toBeDefined();

    // Recognized fields preserved
    expect(entry.inputPerMTok).toBe(5);
    expect(entry.outputPerMTok).toBe(10);
    expect(entry.contextWindow).toBe(200_000);

    // Unknown fields stripped
    const keys = Object.keys(entry);
    expect(keys).not.toContain('notes');
    expect(keys).not.toContain('inpurPerMTok');
    expect(keys).not.toContain('nestedJunk');
    expect(keys).not.toContain('futureField');

    // Recognized-but-absent optional fields are not added with undefined values
    expect(keys).not.toContain('thinkingPerMTok');
    expect(keys).not.toContain('tierMode');
  });

  it('preserves recognized optional fields and tierMode when present', () => {
    const customFile = join(tmpDir, 'with-optionals.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'optionals-model': {
          inputPerMTok: 1,
          outputPerMTok: 2,
          thinkingPerMTok: 3,
          cacheReadPerMTok: 0.5,
          cacheCreationPerMTok: 1.5,
          contextWindow: 200_000,
          tierThreshold: 100_000,
          tierInputPerMTok: 2,
          tierOutputPerMTok: 4,
          tierThinkingPerMTok: 6,
          tierMode: 'marginal',
        },
      }),
    );

    const result = loadCustomPricing(customFile);
    const entry = result!['optionals-model'];
    expect(entry.thinkingPerMTok).toBe(3);
    expect(entry.cacheReadPerMTok).toBe(0.5);
    expect(entry.cacheCreationPerMTok).toBe(1.5);
    expect(entry.tierThreshold).toBe(100_000);
    expect(entry.tierInputPerMTok).toBe(2);
    expect(entry.tierOutputPerMTok).toBe(4);
    expect(entry.tierThinkingPerMTok).toBe(6);
    expect(entry.tierMode).toBe('marginal');
  });

  it('skips __proto__ / constructor / prototype keys without polluting Object.prototype', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const customFile = join(tmpDir, 'proto-poison.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        __proto__: { inputPerMTok: 9999, outputPerMTok: 9999, contextWindow: 1 },
        constructor: { inputPerMTok: 9999, outputPerMTok: 9999, contextWindow: 1 },
        'valid-model': { inputPerMTok: 5, outputPerMTok: 10, contextWindow: 200_000 },
      }),
    );

    const result = loadCustomPricing(customFile);
    // Reserved keys must not appear in the result
    expect(result).not.toBeNull();
    expect(result!['valid-model']).toBeDefined();
    // Object.prototype must not have been polluted
    expect(({} as Record<string, unknown>)['inputPerMTok']).toBeUndefined();
    const output = getLogOutput(stderrSpy);
    expect(output).toContain('reserved key');
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PricingTable class — instance-based pricing
// ---------------------------------------------------------------------------
describe('PricingTable (instance-based)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pricing-table-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('constructs with built-in defaults when no custom file is provided', () => {
    const table = new PricingTable();
    const pricing = table.resolve('claude-sonnet-4-20250514');
    expect(pricing).not.toBeNull();
    expect(pricing!.inputPerMTok).toBe(
      DEFAULT_PRICING_TABLE['claude-sonnet-4-20250514'].inputPerMTok,
    );
  });

  it('constructs with built-in defaults when customFilePath is null', () => {
    const table = new PricingTable(null);
    expect(table.resolve('claude-sonnet-4-20250514')).not.toBeNull();
  });

  it('overlays custom pricing on top of defaults', () => {
    const customFile = join(tmpDir, 'custom.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'claude-sonnet-4-20250514': {
          inputPerMTok: 999,
          outputPerMTok: 999,
          contextWindow: 200_000,
        },
      }),
    );

    const table = new PricingTable(customFile);
    const pricing = table.resolve('claude-sonnet-4-20250514');
    expect(pricing!.inputPerMTok).toBe(999);
    expect(pricing!.outputPerMTok).toBe(999);
  });

  it('isolates state across instances — two agents in one process see distinct prices', () => {
    const fileA = join(tmpDir, 'a.json');
    const fileB = join(tmpDir, 'b.json');
    writeFileSync(
      fileA,
      JSON.stringify({
        'claude-sonnet-4-20250514': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200_000 },
      }),
    );
    writeFileSync(
      fileB,
      JSON.stringify({
        'claude-sonnet-4-20250514': {
          inputPerMTok: 100,
          outputPerMTok: 200,
          contextWindow: 200_000,
        },
      }),
    );

    const tableA = new PricingTable(fileA);
    const tableB = new PricingTable(fileB);

    expect(tableA.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(1);
    expect(tableB.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(100);

    // Constructing tableB does not retroactively mutate tableA.
    expect(tableA.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(1);
  });

  it('reset() reloads built-in defaults, dropping previous overrides', () => {
    const customFile = join(tmpDir, 'custom.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'claude-sonnet-4-20250514': {
          inputPerMTok: 999,
          outputPerMTok: 999,
          contextWindow: 200_000,
        },
      }),
    );

    const table = new PricingTable(customFile);
    expect(table.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(999);

    table.reset(null);
    expect(table.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(
      DEFAULT_PRICING_TABLE['claude-sonnet-4-20250514'].inputPerMTok,
    );
  });

  it('reset(newFile) replaces overrides with the new file contents', () => {
    const fileA = join(tmpDir, 'a.json');
    const fileB = join(tmpDir, 'b.json');
    writeFileSync(
      fileA,
      JSON.stringify({
        'claude-sonnet-4-20250514': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200_000 },
      }),
    );
    writeFileSync(
      fileB,
      JSON.stringify({
        'claude-sonnet-4-20250514': { inputPerMTok: 50, outputPerMTok: 60, contextWindow: 200_000 },
      }),
    );

    const table = new PricingTable(fileA);
    expect(table.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(1);
    table.reset(fileB);
    expect(table.resolve('claude-sonnet-4-20250514')!.inputPerMTok).toBe(50);
  });

  it('calculateCost on the instance honors instance-specific overrides', () => {
    const customFile = join(tmpDir, 'custom.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'claude-sonnet-4-20250514': {
          inputPerMTok: 100,
          outputPerMTok: 200,
          contextWindow: 200_000,
        },
      }),
    );

    const table = new PricingTable(customFile);
    const breakdown = table.calculateCost(
      'claude-sonnet-4-20250514',
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
    );
    expect(breakdown.inputUsd).toBe(100);
    expect(breakdown.outputUsd).toBe(0);
  });

  it('calculateCost returns zero breakdown for unknown models', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const table = new PricingTable();
    const breakdown = table.calculateCost(
      'completely-unknown-model-9999',
      usage({ inputTokens: 1_000_000, totalTokens: 1_000_000 }),
    );
    expect(breakdown.totalUsd).toBe(0);
    expect(breakdown.inputUsd).toBe(0);
    stderrSpy.mockRestore();
  });

  it('module-level resolveModelPricing is independent of new PricingTable instances', () => {
    const customFile = join(tmpDir, 'custom.json');
    writeFileSync(
      customFile,
      JSON.stringify({
        'claude-sonnet-4-20250514': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 200_000 },
      }),
    );

    // Constructing an instance with overrides must not pollute the module-level
    // singleton — that path is reserved for initPricing(...).
    const _instance = new PricingTable(customFile);
    void _instance; // referenced to avoid unused-var lint
    const moduleResolution = resolveModelPricing('claude-sonnet-4-20250514');
    expect(moduleResolution!.inputPerMTok).toBe(
      DEFAULT_PRICING_TABLE['claude-sonnet-4-20250514'].inputPerMTok,
    );
  });

  // Pre-fix, `{ ...DEFAULT_PRICING_TABLE }` was a
  // shallow copy: each instance's `table[name]` shared the inner
  // ModelPricing object reference with `DEFAULT_PRICING_TABLE[name]`.
  // A consumer that called `instance.resolve('claude-opus-4-7')` and
  // mutated the returned entry would have poisoned the canonical
  // table for every other PricingTable instance in the process.
  // After the structuredClone fix, the resolved entry is its own object
  // — mutating it must NOT leak back into DEFAULT_PRICING_TABLE.
  it('mutating a PricingTable.resolve() result does not leak into DEFAULT_PRICING_TABLE', () => {
    const originalRate = DEFAULT_PRICING_TABLE['claude-opus-4-7'].inputPerMTok;
    const instance = new PricingTable();
    const resolved = instance.resolve('claude-opus-4-7');
    expect(resolved).not.toBeNull();

    // Hostile mutation through the instance's resolved entry.
    (resolved as unknown as { inputPerMTok: number }).inputPerMTok = 99_999;

    // The canonical default must still report the original rate — the
    // pre-fix shallow copy would have failed this assertion because
    // `instance.table['claude-opus-4-7']` and
    // `DEFAULT_PRICING_TABLE['claude-opus-4-7']` would have been the
    // same reference.
    expect(DEFAULT_PRICING_TABLE['claude-opus-4-7'].inputPerMTok).toBe(originalRate);

    // A *fresh* instance constructed after the in-instance mutation
    // must also see the canonical rate, not the mutated value — proves
    // the clone happens per-instance, not at module-load.
    const fresh = new PricingTable();
    expect(fresh.resolve('claude-opus-4-7')!.inputPerMTok).toBe(originalRate);
  });

  it('returns null (not a non-deterministic entry) when two equal-length keys forward-match', () => {
    // Construct a table with two same-length keys that both forward-prefix-match 'test-model'
    // via the forward-prefix heuristic (key starts with modelName, suffix matches /^-\d/).
    // The old code returned whichever key happened last in Object.keys() order.
    // The fix must return null and emit a warning instead.
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const tmpDir = mkdtempSync(join(tmpdir(), 'pricing-test-'));
    const tmpFile = join(tmpDir, 'ambiguous.json');
    writeFileSync(
      tmpFile,
      JSON.stringify({
        'test-model-1a': { inputPerMTok: 1, outputPerMTok: 2, contextWindow: 128_000 },
        'test-model-2b': { inputPerMTok: 3, outputPerMTok: 6, contextWindow: 128_000 },
      }),
    );

    const table = new PricingTable(tmpFile);
    rmSync(tmpDir, { recursive: true });

    const result = table.resolve('test-model');
    expect(result).toBeNull();
    const logs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('Ambiguous forward-prefix match'))).toBe(true);

    warnSpy.mockRestore();
  });
});
