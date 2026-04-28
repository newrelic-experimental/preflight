import { DEFAULT_PRICING_TABLE } from './pricing-data.js';

describe('DEFAULT_PRICING_TABLE', () => {
  describe('Anthropic models', () => {
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

    it('has gemini-2.5-flash', () => {
      expect(DEFAULT_PRICING_TABLE['gemini-2.5-flash']).toBeDefined();
    });

    it('has gemini-2.0-flash', () => {
      expect(DEFAULT_PRICING_TABLE['gemini-2.0-flash']).toBeDefined();
    });
  });

  describe('OpenAI models', () => {
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

    it('has o1 with thinking rate', () => {
      const p = DEFAULT_PRICING_TABLE['o1'];
      expect(p).toBeDefined();
      expect(p.inputPerMTok).toBe(15);
      expect(p.outputPerMTok).toBe(60);
      expect(p.thinkingPerMTok).toBe(60);
    });

    it('has o3', () => {
      const p = DEFAULT_PRICING_TABLE['o3'];
      expect(p).toBeDefined();
      expect(p.thinkingPerMTok).toBe(40);
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
        'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-11-20', 'gpt-4o-2024-08-06',
        'gpt-4o-mini-2024-07-18', 'o1', 'o1-mini', 'o1-preview',
        'o3', 'o3-mini', 'o4-mini', 'gpt-4-turbo', 'gpt-3.5-turbo',
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
