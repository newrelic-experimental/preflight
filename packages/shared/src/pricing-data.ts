import type { ModelPricing } from './pricing.js';

// ---------------------------------------------------------------------------
// Built-in pricing table — USD per million tokens
// Sources: Anthropic & Google public pricing pages (May 2025)
// ---------------------------------------------------------------------------

export const DEFAULT_PRICING_TABLE: Record<string, ModelPricing> = {
  // ---- Anthropic ----
  'claude-sonnet-4-20250514': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  'claude-opus-4-20250514': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    thinkingPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
  'claude-haiku-3-5-20241022': {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheCreationPerMTok: 1,
    contextWindow: 200_000,
  },

  // ---- Google Gemini ----
  'gemini-2.5-pro': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    thinkingPerMTok: 10,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 15,
    tierThinkingPerMTok: 15,
  },
  'gemini-2.5-flash': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    thinkingPerMTok: 3.5,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierInputPerMTok: 0.3,
    tierOutputPerMTok: 1.2,
    tierThinkingPerMTok: 7,
  },
  'gemini-2.0-flash': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    contextWindow: 1_000_000,
  },
  'gemini-1.5-pro': {
    inputPerMTok: 1.25,
    outputPerMTok: 5,
    contextWindow: 2_000_000,
    tierThreshold: 128_000,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 10,
  },
  'gemini-1.5-flash': {
    inputPerMTok: 0.075,
    outputPerMTok: 0.3,
    contextWindow: 1_000_000,
    tierThreshold: 128_000,
    tierInputPerMTok: 0.15,
    tierOutputPerMTok: 0.6,
  },
};
