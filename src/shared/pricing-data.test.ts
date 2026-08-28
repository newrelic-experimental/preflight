import { DEFAULT_PRICING_TABLE } from './pricing-data.js';

describe('DEFAULT_PRICING_TABLE', () => {
  describe('Anthropic models', () => {
    it('has claude-opus-4-7 (current gen) with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['claude-opus-4-7'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(5);
      expect(p.outputPerMTok).toBe(25);
      expect(p.thinkingPerMTok).toBe(25);
      expect(p.cacheReadPerMTok).toBe(0.5);
      expect(p.cacheCreationPerMTok).toBe(6.25);
      expect(p.contextWindow).toBe(1_000_000);
    });

    it('has claude-sonnet-4-6 (current gen) with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['claude-sonnet-4-6'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(3);
      expect(p.outputPerMTok).toBe(15);
      expect(p.thinkingPerMTok).toBe(15);
      expect(p.cacheReadPerMTok).toBe(0.3);
      expect(p.cacheCreationPerMTok).toBe(3.75);
      expect(p.contextWindow).toBe(1_000_000);
    });

    it('has claude-haiku-4-5-20251001 with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['claude-haiku-4-5-20251001'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(1);
      expect(p.outputPerMTok).toBe(5);
      expect(p.thinkingPerMTok).toBe(5);
      expect(p.cacheReadPerMTok).toBe(0.1);
      expect(p.cacheCreationPerMTok).toBe(1.25);
      expect(p.contextWindow).toBe(200_000);
    });

    it('has claude-sonnet-4-20250514 with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['claude-sonnet-4-20250514'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(3);
      expect(p.outputPerMTok).toBe(15);
      expect(p.thinkingPerMTok).toBe(15);
      expect(p.cacheReadPerMTok).toBe(0.3);
      expect(p.cacheCreationPerMTok).toBe(3.75);
      expect(p.contextWindow).toBe(200_000);
    });

    it('has claude-opus-4-20250514 with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['claude-opus-4-20250514'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(15);
      expect(p.outputPerMTok).toBe(75);
    });

    it('has claude-haiku-3-5-20241022', () => {
      expect(DEFAULT_PRICING_TABLE['claude-haiku-3-5-20241022']).toBeDefined();
    });
  });

  describe('Google Gemini models', () => {
    it('has gemini-2.5-pro with tiered pricing', () => {
      const p = DEFAULT_PRICING_TABLE['gemini-2.5-pro'];
      expect(p).toBeDefined();
      expect(p.tierThreshold).toBe(200_000);
      expect(p.tierInputPerMTok).toBeDefined();
      expect(p.contextWindow).toBe(1_000_000);
    });

    it('has gemini-2.5-flash with flat pricing (no tiers) at May 2026 rates', () => {
      const p = DEFAULT_PRICING_TABLE['gemini-2.5-flash'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(0.3);
      expect(p.outputPerMTok).toBe(2.5);
      expect(p.thinkingPerMTok).toBe(2.5);
      // No tiers — Gemini 2.5 Flash switched to flat pricing in 2026
      expect(p.tierThreshold).toBeUndefined();
      expect(p.tierInputPerMTok).toBeUndefined();
    });

    it('has gemini-2.5-flash-lite', () => {
      const p = DEFAULT_PRICING_TABLE['gemini-2.5-flash-lite'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(0.1);
      expect(p.outputPerMTok).toBe(0.4);
    });

    it('has gemini-3.1-pro-preview with tiered pricing', () => {
      const p = DEFAULT_PRICING_TABLE['gemini-3.1-pro-preview'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(2);
      expect(p.outputPerMTok).toBe(12);
      expect(p.tierThreshold).toBe(200_000);
      expect(p.tierInputPerMTok).toBe(4);
      expect(p.contextWindow).toBe(1_000_000);
    });

    it('has gemini-2.0-flash', () => {
      expect(DEFAULT_PRICING_TABLE['gemini-2.0-flash']).toBeDefined();
    });
  });

  describe('OpenAI models', () => {
    it('has gpt-5.5 with correct rates and flat long-context tier', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-5.5'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(5);
      expect(p.outputPerMTok).toBe(30);
      expect(p.cacheReadPerMTok).toBe(0.5);
      expect(p.contextWindow).toBe(1_050_000);
      expect(p.tierThreshold).toBe(272_000);
      // 'flat' is the default (tierMode omitted) — OpenAI bills the entire
      // request at tier rates once inputTokens > threshold, output included.
      expect(p.tierMode).toBeUndefined();
      expect(p.tierInputPerMTok).toBe(10);
      expect(p.tierOutputPerMTok).toBe(45);
    });

    it('has gpt-5.4 with correct rates and flat long-context tier', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-5.4'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(2.5);
      expect(p.outputPerMTok).toBe(15);
      expect(p.cacheReadPerMTok).toBe(0.25);
      expect(p.contextWindow).toBe(1_050_000);
      expect(p.tierThreshold).toBe(272_000);
      expect(p.tierMode).toBeUndefined();
      expect(p.tierInputPerMTok).toBe(5);
      expect(p.tierOutputPerMTok).toBe(22.5);
    });

    it('has gpt-5 as its own real entry, not aliased to gpt-5.5/5.6', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-5'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(1.25);
      expect(p.outputPerMTok).toBe(10);
      expect(p.contextWindow).toBe(400_000);
    });

    it('has the gpt-5.6 family (Sol/Terra/Luna) with correct rates and flat long-context tier', () => {
      const sol = DEFAULT_PRICING_TABLE['gpt-5.6-sol'];
      expect(sol).toBeDefined();
      expect(sol.inputPerMTok).toBe(4);
      expect(sol.outputPerMTok).toBe(20);
      expect(sol.contextWindow).toBe(1_050_000);
      expect(sol.tierThreshold).toBe(272_000);
      expect(sol.tierInputPerMTok).toBe(8);
      expect(sol.tierOutputPerMTok).toBe(30);

      expect(DEFAULT_PRICING_TABLE['gpt-5.6-terra']).toBeDefined();
      expect(DEFAULT_PRICING_TABLE['gpt-5.6-luna']).toBeDefined();
    });

    it('has gpt-5.4-mini and gpt-5.4-nano', () => {
      expect(DEFAULT_PRICING_TABLE['gpt-5.4-mini']).toBeDefined();
      expect(DEFAULT_PRICING_TABLE['gpt-5.4-nano']).toBeDefined();
    });

    it('has gpt-4o with correct rates', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-4o'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(2.5);
      expect(p.outputPerMTok).toBe(10);
      expect(p.contextWindow).toBe(128_000);
    });

    it('has gpt-4o-mini', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-4o-mini'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(0.15);
      expect(p.outputPerMTok).toBe(0.6);
    });

    it('has o1 — no separate thinkingPerMTok (reasoning billed via outputTokens)', () => {
      const p = DEFAULT_PRICING_TABLE['o1'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(15);
      expect(p.outputPerMTok).toBe(60);
      // thinkingPerMTok intentionally absent: OpenAI includes reasoning tokens
      // in completion_tokens at outputPerMTok — a separate thinkingPerMTok would
      // double-bill.
      expect(p.thinkingPerMTok).toBeUndefined();
    });

    it('has o3 at its current repriced rate — no separate thinkingPerMTok (reasoning billed via outputTokens)', () => {
      const p = DEFAULT_PRICING_TABLE['o3'];
      expect(p).toBeDefined();
      // Repriced down from its April 2025 launch rate ($10/$40).
      expect(p.inputPerMTok).toBe(2);
      expect(p.outputPerMTok).toBe(8);
      expect(p.cacheReadPerMTok).toBe(0.5);
      expect(p.thinkingPerMTok).toBeUndefined();
    });

    it('has o4-mini', () => {
      expect(DEFAULT_PRICING_TABLE['o4-mini']).toBeDefined();
    });

    it('has gpt-4-turbo', () => {
      const p = DEFAULT_PRICING_TABLE['gpt-4-turbo'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(10);
    });

    it('has gpt-3.5-turbo', () => {
      expect(DEFAULT_PRICING_TABLE['gpt-3.5-turbo']).toBeDefined();
    });

    it('all OpenAI entries have required fields', () => {
      const openaiModels = [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4o-2024-11-20',
        'gpt-4o-2024-08-06',
        'gpt-4o-mini-2024-07-18',
        'o1',
        'o1-mini',
        'o1-preview',
        'o3',
        'o3-mini',
        'o4-mini',
        'gpt-4-turbo',
        'gpt-3.5-turbo',
      ];
      for (const model of openaiModels) {
        const p = DEFAULT_PRICING_TABLE[model];
        expect(p).toBeDefined();
        expect(typeof p.inputPerMTok).toBe('number');
        expect(typeof p.outputPerMTok).toBe('number');
        expect(typeof p.contextWindow).toBe('number');
      }
    });
  });

  describe('AWS Bedrock models', () => {
    // Bare `anthropic.*` keys price the Geo/In-region tier; `global.anthropic.*`
    // keys price the ~10%-cheaper Global tier. Every current-gen pair should
    // be internally consistent: bare = global * 1.1 on every rate field.
    it('prices bare anthropic.* keys at 1.1x their global.anthropic.* counterpart', () => {
      const currentGenModels = [
        'anthropic.claude-sonnet-5',
        'anthropic.claude-fable-5',
        'anthropic.claude-opus-5',
        'anthropic.claude-opus-4-8',
        'anthropic.claude-opus-4-7',
        'anthropic.claude-sonnet-4-6',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ];
      for (const model of currentGenModels) {
        const geo = DEFAULT_PRICING_TABLE[model];
        const global = DEFAULT_PRICING_TABLE[`global.${model}`];
        expect(geo).toBeDefined();
        expect(global).toBeDefined();
        expect(geo.inputPerMTok).toBeCloseTo(global.inputPerMTok * 1.1, 5);
        expect(geo.outputPerMTok).toBeCloseTo(global.outputPerMTok * 1.1, 5);
        expect(geo.cacheReadPerMTok).toBeCloseTo(global.cacheReadPerMTok! * 1.1, 5);
        expect(geo.cacheCreationPerMTok).toBeCloseTo(global.cacheCreationPerMTok! * 1.1, 5);
        expect(geo.contextWindow).toBe(global.contextWindow);
      }
    });

    it('has claude-sonnet-5 Geo/In-region rate confirmed exactly against AWS pricing data', () => {
      const p = DEFAULT_PRICING_TABLE['anthropic.claude-sonnet-5'];
      expect(p.inputPerMTok).toBe(2.2);
      expect(p.outputPerMTok).toBe(11);
      expect(p.cacheReadPerMTok).toBe(0.22);
      expect(p.cacheCreationPerMTok).toBe(2.75);
    });

    it('has claude-sonnet-5 Global tier matching Anthropic direct-API pricing (Bedrock parity)', () => {
      const bedrockGlobal = DEFAULT_PRICING_TABLE['global.anthropic.claude-sonnet-5'];
      const directApi = DEFAULT_PRICING_TABLE['claude-sonnet-5'];
      expect(bedrockGlobal.inputPerMTok).toBe(directApi.inputPerMTok);
      expect(bedrockGlobal.outputPerMTok).toBe(directApi.outputPerMTok);
    });
  });

  describe('table structure', () => {
    it('all entries have positive inputPerMTok and outputPerMTok', () => {
      for (const [model, p] of Object.entries(DEFAULT_PRICING_TABLE)) {
        expect(p.inputPerMTok).toBeGreaterThan(0);
        expect(p.outputPerMTok).toBeGreaterThan(0);
        expect(p.contextWindow).toBeGreaterThan(0);
        expect(model).toBeTruthy();
      }
    });

    it('contains entries from all three providers', () => {
      const keys = Object.keys(DEFAULT_PRICING_TABLE);
      const hasAnthropic = keys.some((k) => k.startsWith('claude-'));
      const hasGemini = keys.some((k) => k.startsWith('gemini-'));
      const hasOpenAI = keys.some((k) => k.startsWith('gpt-') || k.startsWith('o'));
      expect(hasAnthropic).toBe(true);
      expect(hasGemini).toBe(true);
      expect(hasOpenAI).toBe(true);
    });
  });
});
