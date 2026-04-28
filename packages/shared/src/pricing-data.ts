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

  // ---- OpenAI ----
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  'gpt-4o-2024-11-20': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  'gpt-4o-2024-08-06': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  'gpt-4o-mini-2024-07-18': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  'o1': {
    inputPerMTok: 15,
    outputPerMTok: 60,
    thinkingPerMTok: 60,
    contextWindow: 200_000,
  },
  'o1-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    contextWindow: 128_000,
  },
  'o1-preview': {
    inputPerMTok: 15,
    outputPerMTok: 60,
    contextWindow: 128_000,
  },
  'o3': {
    inputPerMTok: 10,
    outputPerMTok: 40,
    thinkingPerMTok: 40,
    contextWindow: 200_000,
  },
  'o3-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    contextWindow: 200_000,
  },
  'o4-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    contextWindow: 200_000,
  },
  'gpt-4-turbo': {
    inputPerMTok: 10,
    outputPerMTok: 30,
    contextWindow: 128_000,
  },
  'gpt-3.5-turbo': {
    inputPerMTok: 0.5,
    outputPerMTok: 1.5,
    contextWindow: 16_385,
  },
};
