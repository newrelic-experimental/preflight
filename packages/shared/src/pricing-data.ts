import type { ModelPricing } from './pricing.js';

// ---------------------------------------------------------------------------
// Built-in pricing table — USD per million tokens
// Sources: Anthropic, Google, OpenAI public pricing pages (May 2026)
// ---------------------------------------------------------------------------

export const DEFAULT_PRICING_TABLE: Record<string, ModelPricing> = {
  // ---- Anthropic (current generation) ----
  'claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 1_000_000,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheCreationPerMTok: 1.25,
    contextWindow: 200_000,
  },

  // ---- Anthropic (legacy Claude 4 generation) ----
  'claude-opus-4-6': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 200_000,
  },
  'claude-sonnet-4-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  'claude-opus-4-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 200_000,
  },
  'claude-opus-4-1': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    thinkingPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
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

  // ---- Google Gemini (current generation) ----
  'gemini-3.1-pro-preview': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    thinkingPerMTok: 12,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 18,
    tierThinkingPerMTok: 18,
  },
  'gemini-3.1-flash-lite-preview': {
    inputPerMTok: 0.25,
    outputPerMTok: 1.5,
    contextWindow: 1_000_000,
  },
  'gemini-3-flash-preview': {
    inputPerMTok: 0.5,
    outputPerMTok: 3,
    contextWindow: 1_000_000,
  },

  // ---- Google Gemini 2.5 ----
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
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    thinkingPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  'gemini-2.5-flash-lite': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    contextWindow: 1_000_000,
  },

  // ---- Google Gemini 2.0 (deprecated — shutting down June 1 2026) ----
  'gemini-2.0-flash': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    contextWindow: 1_000_000,
  },

  // ---- Google Gemini 1.5 (legacy) ----
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

  // ---- OpenAI (current generation) ----
  'gpt-5.5': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    contextWindow: 1_000_000,
    tierThreshold: 270_000,
    tierInputPerMTok: 10,
    tierOutputPerMTok: 45,
  },
  'gpt-5.4': {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.25,
    contextWindow: 1_000_000,
    tierThreshold: 270_000,
    tierInputPerMTok: 5,
    tierOutputPerMTok: 22.5,
  },
  'gpt-5.4-mini': {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.075,
    contextWindow: 128_000,
  },
  'gpt-5.4-nano': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.25,
    cacheReadPerMTok: 0.02,
    contextWindow: 128_000,
  },

  // ---- OpenAI (legacy) ----
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

  // ---- AWS Bedrock (Converse API pricing for on-demand) ----
  // Current Claude generation via Bedrock
  'anthropic.claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    contextWindow: 200_000,
  },
  // Legacy Claude models via Bedrock cross-region inference
  'anthropic.claude-3-5-sonnet-20241022-v2:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-5-haiku-20241022-v1:0': {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-opus-20240229-v1:0': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    contextWindow: 200_000,
  },
  // Meta Llama via Bedrock
  'meta.llama3-70b-instruct-v1:0': {
    inputPerMTok: 0.99,
    outputPerMTok: 0.99,
    contextWindow: 128_000,
  },
  'meta.llama3-8b-instruct-v1:0': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  // Mistral via Bedrock
  'mistral.mistral-large-2402-v1:0': {
    inputPerMTok: 4,
    outputPerMTok: 12,
    contextWindow: 32_000,
  },
  'mistral.mistral-small-2402-v1:0': {
    inputPerMTok: 1,
    outputPerMTok: 3,
    contextWindow: 32_000,
  },
  // Amazon Nova
  'amazon.nova-pro-v1:0': {
    inputPerMTok: 0.8,
    outputPerMTok: 3.2,
    contextWindow: 300_000,
  },
  'amazon.nova-lite-v1:0': {
    inputPerMTok: 0.06,
    outputPerMTok: 0.24,
    contextWindow: 300_000,
  },
  'amazon.nova-micro-v1:0': {
    inputPerMTok: 0.035,
    outputPerMTok: 0.14,
    contextWindow: 128_000,
  },

  // ---- Mistral ----
  'mistral-large-latest': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    contextWindow: 131_000,
  },
  'mistral-small-latest': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.3,
    contextWindow: 131_000,
  },
  'mistral-nemo': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.15,
    contextWindow: 131_000,
  },
  // ---- Mistral (legacy — deprecated March 2025) ----
  'open-mistral-7b': {
    inputPerMTok: 0.25,
    outputPerMTok: 0.25,
    contextWindow: 32_000,
  },
  'open-mixtral-8x7b': {
    inputPerMTok: 0.7,
    outputPerMTok: 0.7,
    contextWindow: 32_000,
  },
  'codestral-latest': {
    inputPerMTok: 0.2,
    outputPerMTok: 0.6,
    contextWindow: 256_000,
  },

  // ---- Cohere ----
  'command-r-plus': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  'command-r': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  'command': {
    inputPerMTok: 1,
    outputPerMTok: 2,
    contextWindow: 4_000,
  },
  'command-light': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.6,
    contextWindow: 4_000,
  },
};
