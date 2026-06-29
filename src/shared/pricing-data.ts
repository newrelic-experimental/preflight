import type { ModelPricing } from './pricing.js';

// ---------------------------------------------------------------------------
// Family-name aliases → current-generation key
//
// When a caller passes a family name (e.g. "claude-opus-4"), they almost
// always mean "the current generation of that family". Without an explicit
// alias, the prefix-match heuristic in resolveModelPricing() prefers longer
// keys (dated suffixes like "-20250514") and silently returns LEGACY pricing,
// e.g. claude-opus-4 → claude-opus-4-20250514 ($15/$75) instead of the
// current claude-opus-4-7 ($5/$25). That's a 3× cost overestimate.
//
// Resolution order in resolveModelPricing(): exact → alias → forward-prefix
// → reverse-prefix → null.
// ---------------------------------------------------------------------------
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic Claude families
  'claude-opus-4': 'claude-opus-4-7',
  'claude-sonnet-4': 'claude-sonnet-4-6',
  'claude-haiku-4': 'claude-haiku-4-5',
  'claude-haiku-3-5': 'claude-haiku-3-5-20241022',

  // Google Gemini current-gen shortcuts
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  // Gemini family shortcuts: without these, bare family queries like
  // 'gemini-2.5' return null (gpt-style .x suffixes don't match -\d prefix
  // heuristic) or non-deterministically pick between pro/flash.
  'gemini-2.5': 'gemini-2.5-pro',
  'gemini-2.0': 'gemini-2.0-flash',

  // OpenAI family shortcuts: 'gpt-5' has no exact key and the .x
  // suffix prevents the forward-prefix heuristic from matching.
  'gpt-5': 'gpt-5.5',
};

// ---------------------------------------------------------------------------
// Built-in pricing table — USD per million tokens
//
// Rates last verified against vendor public pricing pages on 2026-05-20:
//   - Anthropic   https://www.anthropic.com/pricing
//   - Google      https://cloud.google.com/vertex-ai/generative-ai/pricing
//   - OpenAI      https://openai.com/api/pricing/
//   - Cohere      https://cohere.com/pricing
//   - Mistral     https://mistral.ai/pricing
//   - Bedrock     https://aws.amazon.com/bedrock/pricing/
//
// When updating rates, bump the date above so consumers can tell at a glance
// how stale the built-in table is. Pricing changes on these pages are usually
// announced; the date is the verification timestamp, not a guarantee that
// the rate hasn't shifted since.
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
  // Dateless current-gen entry — MODEL_ALIASES['claude-haiku-4'] routes here.
  // Matches the opus/sonnet convention: alias → dateless key → dated legacy key.
  // Update this entry when Haiku 4.x rates change; the dated entry below is
  // retained only for historical-cost backfill.
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheCreationPerMTok: 1.25,
    contextWindow: 200_000,
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
  // These legacy entries share input/output/cache rates
  // with their current-generation counterparts, but `contextWindow` differs
  // (200K legacy vs 1M current). They are NOT alias candidates: the cost
  // calculations downstream don't use contextWindow, but downstream tooling
  // (e.g. context-fit checks, dashboard filters by window size) does. Keep
  // the entries explicit. Family-name routing (e.g. `claude-opus-4` →
  // current generation) is handled by MODEL_ALIASES above.
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
  // WARNING: this key uses a version-number suffix (-1) not a date suffix.
  // The reverse-prefix algorithm strips only 8-digit date suffixes, so a
  // future model named 'claude-opus-4-10' (or 'claude-opus-4-100') would
  // match this entry via reverse-prefix because
  // 'claude-opus-4-10'.startsWith('claude-opus-4-1') is true.
  // If Anthropic releases a claude-opus-4-10 model, add an explicit alias
  // before that model key appears in the table.
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

  // ---- Google Gemini 2.0 ----
  // Retained past Google's published 2026-06-01 deprecation date for
  // historical-cost backfill: events recorded against `gemini-2.0-flash`
  // before the cutover may still flow through the harvest scheduler from
  // long-running consumer apps that haven't migrated yet, and we'd rather
  // they get a correct cost figure than fall through to the unknown-model
  // zero rate. Rate values are the last published Google pricing as of
  // that date and will be removed in a future release after the migration
  // window closes.
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
    // OpenAI long-context pricing is marginal: only tokens above 270k are
    // billed at the tier rate — not the entire request.
    tierThreshold: 270_000,
    tierMode: 'marginal',
    tierInputPerMTok: 10,
    tierOutputPerMTok: 45,
  },
  'gpt-5.4': {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.25,
    contextWindow: 1_000_000,
    tierThreshold: 270_000,
    tierMode: 'marginal',
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
  o1: {
    inputPerMTok: 15,
    outputPerMTok: 60,
    // No thinkingPerMTok: OpenAI bills reasoning tokens as part of
    // completion_tokens at outputPerMTok. The extractor sets thinkingTokens
    // from completion_tokens_details.reasoning_tokens as an informational
    // breakdown, but those tokens are already counted in outputTokens, so
    // a separate thinkingPerMTok rate would double-bill.
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
  o3: {
    inputPerMTok: 10,
    outputPerMTok: 40,
    // No thinkingPerMTok — see 'o1' comment above.
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
  // NOTE: cache pricing for claude-opus-4-7 and claude-sonnet-4-6 on
  // Bedrock has not been publicly documented as of 2026-06-03. Rates below are
  // omitted until verified against the AWS Bedrock pricing page.
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
  // Cache rates verified against AWS Bedrock pricing page (2026-06-03).
  'anthropic.claude-3-5-sonnet-20241022-v2:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.6,
    cacheCreationPerMTok: 7.5,
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
    contextWindow: 131_072,
  },
  'mistral-small-latest': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.3,
    contextWindow: 131_072,
  },
  'mistral-nemo': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.15,
    contextWindow: 131_072,
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
  // `command` and `command-light` are deprecated (2024)
  // but retained for historical-cost backfill of consumer apps that haven't
  // migrated. Context window is 4096 tokens, not 4000 — the round-number
  // approximation in the original entry was off by 96 tokens.
  command: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    contextWindow: 4_096,
  },
  'command-light': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.6,
    contextWindow: 4_096,
  },
};
