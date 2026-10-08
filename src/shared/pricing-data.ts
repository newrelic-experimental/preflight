import type { ModelPricing } from './pricing.js';

// ---------------------------------------------------------------------------
// Family-name aliases → current-generation key
//
// When a caller passes a family name (e.g. "claude-opus-4"), they almost
// always mean "the current generation of that family". Without an explicit
// alias, the prefix-match heuristic in resolveModelPricing() prefers longer
// keys (dated suffixes like "-20250514") and silently returns LEGACY pricing,
// e.g. claude-opus-4 → claude-opus-4-20250514 ($15/$75) instead of the
// current claude-opus-4-8 ($5/$25). That's a 3× cost overestimate.
//
// Resolution order in resolveModelPricing(): exact → alias → forward-prefix
// → reverse-prefix → null.
// ---------------------------------------------------------------------------
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic Claude families
  'claude-opus-4': 'claude-opus-4-8',
  'claude-sonnet-4': 'claude-sonnet-4-6',
  'claude-haiku-4': 'claude-haiku-4-5',
  'claude-haiku-3-5': 'claude-haiku-3-5-20241022',

  // Google Gemini current-gen shortcuts
  'gemini-3.5': 'gemini-3.5-flash',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  // Same model and price as 3.1 Pro Preview, with a tool-use-tuned endpoint
  // (ai.google.dev lists both IDs under one price).
  'gemini-3.1-pro-preview-customtools': 'gemini-3.1-pro-preview',
  // No alias for 'gemini-3.1-flash-lite' — it's now an exact-match table key
  // in its own right (GA'd, dropped the "-preview" suffix). An earlier
  // revision of this file aliased it to 'gemini-3.1-flash-lite-preview',
  // which is backwards: that ID is the one that's been shut down.
  'gemini-3-flash': 'gemini-3-flash-preview',
  // Gemini family shortcuts: without these, bare family queries like
  // 'gemini-2.5' return null (gpt-style .x suffixes don't match -\d prefix
  // heuristic) or non-deterministically pick between pro/flash.
  'gemini-2.5': 'gemini-2.5-pro',
  'gemini-2.0': 'gemini-2.0-flash',

  // OpenAI: 'gpt-5.6' is OpenAI's own documented alias for its flagship
  // model within the 5.6 family (mirrors the API's own alias behavior).
  // No shortcut for bare 'gpt-5' — it's NOT shorthand for the current
  // flagship, it's a real, separately priced model with its own exact-match
  // table entry (see DEFAULT_PRICING_TABLE['gpt-5']). An earlier revision of
  // this file aliased 'gpt-5' -> 'gpt-5.5', which over-billed real `gpt-5`
  // calls by several times ($1.25/$10 actual vs $5/$30 aliased).
  'gpt-5.6': 'gpt-5.6-sol',

  // AWS Bedrock geo cross-region inference profile IDs. These are a
  // different kind of alias than the family-name shortcuts above — each is
  // a real, literal AWS inference-profile ID, routed here because AWS bills
  // every region below identically to the bare `anthropic.*` "in-region"
  // key it points at (see the Bedrock section's tier comment in
  // DEFAULT_PRICING_TABLE for the pricing rationale). The in./apac. and
  // non-Claude entries further down are taken from AWS model cards. The
  // us./eu./au./jp. Claude entries are not verified per model — AWS's
  // regional rollout varies, but an alias for a region AWS doesn't actually
  // offer is simply unreachable in practice, not a source of mispricing.
  'us.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'eu.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'au.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'jp.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'us.anthropic.claude-fable-5': 'anthropic.claude-fable-5',
  'eu.anthropic.claude-fable-5': 'anthropic.claude-fable-5',
  'au.anthropic.claude-fable-5': 'anthropic.claude-fable-5',
  'jp.anthropic.claude-fable-5': 'anthropic.claude-fable-5',
  'us.anthropic.claude-opus-5': 'anthropic.claude-opus-5',
  'eu.anthropic.claude-opus-5': 'anthropic.claude-opus-5',
  'au.anthropic.claude-opus-5': 'anthropic.claude-opus-5',
  'jp.anthropic.claude-opus-5': 'anthropic.claude-opus-5',
  'us.anthropic.claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'eu.anthropic.claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'au.anthropic.claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'jp.anthropic.claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'eu.anthropic.claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'au.anthropic.claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'jp.anthropic.claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'eu.anthropic.claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'au.anthropic.claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'jp.anthropic.claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'au.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'jp.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'eu.anthropic.claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'au.anthropic.claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'jp.anthropic.claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'us.anthropic.claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'eu.anthropic.claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'au.anthropic.claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'jp.anthropic.claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'us.anthropic.claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'eu.anthropic.claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'au.anthropic.claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'jp.anthropic.claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'us.anthropic.claude-mythos-5': 'anthropic.claude-mythos-5',
  'eu.anthropic.claude-mythos-5': 'anthropic.claude-mythos-5',
  'au.anthropic.claude-mythos-5': 'anthropic.claude-mythos-5',
  'jp.anthropic.claude-mythos-5': 'anthropic.claude-mythos-5',
  'us.anthropic.claude-mythos-5-1': 'anthropic.claude-mythos-5-1',
  'eu.anthropic.claude-mythos-5-1': 'anthropic.claude-mythos-5-1',
  'au.anthropic.claude-mythos-5-1': 'anthropic.claude-mythos-5-1',
  'jp.anthropic.claude-mythos-5-1': 'anthropic.claude-mythos-5-1',
  'us.anthropic.claude-mythos-preview': 'anthropic.claude-mythos-preview',
  'eu.anthropic.claude-mythos-preview': 'anthropic.claude-mythos-preview',
  'au.anthropic.claude-mythos-preview': 'anthropic.claude-mythos-preview',
  'jp.anthropic.claude-mythos-preview': 'anthropic.claude-mythos-preview',
  'us.anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-6-v1',
  'eu.anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-6-v1',
  'au.anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-6-v1',
  'jp.anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'au.anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'jp.anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'au.anthropic.claude-sonnet-4-5-20250929-v1:0': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'jp.anthropic.claude-sonnet-4-5-20250929-v1:0': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.anthropic.claude-sonnet-4-20250514-v1:0': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'eu.anthropic.claude-sonnet-4-20250514-v1:0': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'au.anthropic.claude-sonnet-4-20250514-v1:0': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'jp.anthropic.claude-sonnet-4-20250514-v1:0': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0': 'anthropic.claude-opus-4-1-20250805-v1:0',
  'eu.anthropic.claude-opus-4-1-20250805-v1:0': 'anthropic.claude-opus-4-1-20250805-v1:0',
  'au.anthropic.claude-opus-4-1-20250805-v1:0': 'anthropic.claude-opus-4-1-20250805-v1:0',
  'jp.anthropic.claude-opus-4-1-20250805-v1:0': 'anthropic.claude-opus-4-1-20250805-v1:0',
  'us.anthropic.claude-opus-4-20250514-v1:0': 'anthropic.claude-opus-4-20250514-v1:0',
  'eu.anthropic.claude-opus-4-20250514-v1:0': 'anthropic.claude-opus-4-20250514-v1:0',
  'au.anthropic.claude-opus-4-20250514-v1:0': 'anthropic.claude-opus-4-20250514-v1:0',
  'jp.anthropic.claude-opus-4-20250514-v1:0': 'anthropic.claude-opus-4-20250514-v1:0',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'eu.anthropic.claude-3-7-sonnet-20250219-v1:0': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'au.anthropic.claude-3-7-sonnet-20250219-v1:0': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'jp.anthropic.claude-3-7-sonnet-20250219-v1:0': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'us.anthropic.claude-3-haiku-20240307-v1:0': 'anthropic.claude-3-haiku-20240307-v1:0',
  'eu.anthropic.claude-3-haiku-20240307-v1:0': 'anthropic.claude-3-haiku-20240307-v1:0',
  'au.anthropic.claude-3-haiku-20240307-v1:0': 'anthropic.claude-3-haiku-20240307-v1:0',
  'jp.anthropic.claude-3-haiku-20240307-v1:0': 'anthropic.claude-3-haiku-20240307-v1:0',
  'us.anthropic.claude-3-sonnet-20240229-v1:0': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'eu.anthropic.claude-3-sonnet-20240229-v1:0': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'au.anthropic.claude-3-sonnet-20240229-v1:0': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'jp.anthropic.claude-3-sonnet-20240229-v1:0': 'anthropic.claude-3-sonnet-20240229-v1:0',
  // Legacy dated IDs: without these, `us.`/`eu.`-prefixed profiles resolve to
  // null ($0) because the prefix-match fallback can't strip a region prefix.
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'eu.anthropic.claude-3-5-sonnet-20241022-v2:0': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'eu.anthropic.claude-3-5-haiku-20241022-v1:0': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'us.anthropic.claude-3-opus-20240229-v1:0': 'anthropic.claude-3-opus-20240229-v1:0',
  'eu.anthropic.claude-3-opus-20240229-v1:0': 'anthropic.claude-3-opus-20240229-v1:0',

  // Geo inference profiles for the remaining Bedrock models, per their AWS model cards.
  'in.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'in.anthropic.claude-opus-5': 'anthropic.claude-opus-5',
  'in.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'apac.anthropic.claude-sonnet-4-20250514-v1:0': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'eu.anthropic.claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'au.anthropic.claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'jp.anthropic.claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'us.amazon.nova-2-lite-v1:0': 'amazon.nova-2-lite-v1:0',
  'eu.amazon.nova-2-lite-v1:0': 'amazon.nova-2-lite-v1:0',
  'jp.amazon.nova-2-lite-v1:0': 'amazon.nova-2-lite-v1:0',
  'us.amazon.nova-lite-v1:0': 'amazon.nova-lite-v1:0',
  'eu.amazon.nova-lite-v1:0': 'amazon.nova-lite-v1:0',
  'us.amazon.nova-micro-v1:0': 'amazon.nova-micro-v1:0',
  'eu.amazon.nova-micro-v1:0': 'amazon.nova-micro-v1:0',
  'us.amazon.nova-pro-v1:0': 'amazon.nova-pro-v1:0',
  'eu.amazon.nova-pro-v1:0': 'amazon.nova-pro-v1:0',
  'apac.amazon.nova-pro-v1:0': 'amazon.nova-pro-v1:0',
  'us.meta.llama4-maverick-17b-instruct-v1:0': 'meta.llama4-maverick-17b-instruct-v1:0',
  'us.meta.llama4-scout-17b-instruct-v1:0': 'meta.llama4-scout-17b-instruct-v1:0',
  'us.meta.llama3-3-70b-instruct-v1:0': 'meta.llama3-3-70b-instruct-v1:0',
  'us.meta.llama3-2-11b-instruct-v1:0': 'meta.llama3-2-11b-instruct-v1:0',
  'us.meta.llama3-2-90b-instruct-v1:0': 'meta.llama3-2-90b-instruct-v1:0',
  'us.meta.llama3-1-8b-instruct-v1:0': 'meta.llama3-1-8b-instruct-v1:0',
  'us.meta.llama3-1-70b-instruct-v1:0': 'meta.llama3-1-70b-instruct-v1:0',
  'us.meta.llama3-2-1b-instruct-v1:0': 'meta.llama3-2-1b-instruct-v1:0',
  'eu.meta.llama3-2-1b-instruct-v1:0': 'meta.llama3-2-1b-instruct-v1:0',
  'us.meta.llama3-2-3b-instruct-v1:0': 'meta.llama3-2-3b-instruct-v1:0',
  'eu.meta.llama3-2-3b-instruct-v1:0': 'meta.llama3-2-3b-instruct-v1:0',
  'us.mistral.pixtral-large-2502-v1:0': 'mistral.pixtral-large-2502-v1:0',
  'eu.mistral.pixtral-large-2502-v1:0': 'mistral.pixtral-large-2502-v1:0',

  // Mistral's pricing page now shows a "-latest" alias for each Ministral 3
  // size, routing to the dated snapshot IDs that are this table's actual
  // keys (see the Ministral 3 comment in DEFAULT_PRICING_TABLE).
  'ministral-3b-latest': 'ministral-3b-2512',
  'ministral-8b-latest': 'ministral-8b-2512',
  'ministral-14b-latest': 'ministral-14b-2512',
};

// ---------------------------------------------------------------------------
// Built-in pricing table — USD per million tokens
//
// Rates last fully verified against vendor public pricing pages on
// 2026-08-27. Later partial passes: Anthropic 5.5, GPT-6, Bedrock, xAI,
// Moonshot, Mistral Large 4 and the Copilot stale-entry notes on 2026-10-07;
// OpenAI long-context cache tiers, xAI cache tiers and Moonshot cache writes
// on 2026-10-08:
//   - Anthropic   https://www.anthropic.com/pricing, docs.claude.com
//   - Google      https://ai.google.dev/gemini-api/docs/pricing
//   - OpenAI      https://platform.openai.com/docs/pricing, /docs/models
//   - Cohere      https://cohere.com/pricing, docs.cohere.com
//   - Mistral     https://mistral.ai/pricing, docs.mistral.ai
//   - Bedrock     https://aws.amazon.com/bedrock/pricing/
//
// A handful of entries (marked individually below) are instead sourced from
// GitHub Copilot's own pricing page, verified 2026-08-27 (delistings re-checked
// 2026-10-07):
//   - GitHub Copilot  https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// Copilot's per-token pricing is a verified passthrough of each underlying
// vendor's own direct-API list price, not a Copilot-specific markup —
// cross-checked against this table's existing claude-opus-4-8, claude-sonnet-5,
// gpt-5.4, and gpt-5.5 entries, all exact matches. It's used here only for
// models a primary vendor page doesn't directly document (or that don't have
// one at all, e.g. GitHub's own fine-tuned Raptor mini). contextWindow on
// these entries is a non-billing-critical best-effort default (not used in
// calculateCost()'s pricing math, only validated as a positive integer) —
// unlike the rest of this table, it is NOT verified against a per-model
// context-limit source, since Copilot's pricing page doesn't publish one.
//
// When updating rates, bump the date above so consumers can tell at a glance
// how stale the built-in table is. Pricing changes on these pages are usually
// announced; the date is the verification timestamp, not a guarantee that
// the rate hasn't shifted since.
// ---------------------------------------------------------------------------

export const DEFAULT_PRICING_TABLE: Record<string, ModelPricing> = {
  // ---- Anthropic (current generation) ----
  // Claude Fable 5 GA'd publicly on June 9, 2026 under this exact model ID
  // (docs.claude.com/.../introducing-claude-fable-5-and-claude-mythos-5) —
  // no longer an internal/beta codename.
  'claude-fable-5': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  // Shares Fable 5's specs and pricing exactly, but is limited-availability
  // only (Project Glasswing, no safety classifiers). Most callers won't hit
  // this ID, but it's a real, priced model if they do.
  'claude-mythos-5': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  // Extends Fable 5 at the same input/output prices, with cache reads at a
  // quarter of the usual 0.1x-input multiplier (0.025x here) — cache
  // writes are unaffected, still the standard 1.25x-input rate. GA, labeled
  // "Latest" on docs.claude.com.
  'claude-fable-5-1': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  // Shares Fable 5.1's specs and pricing exactly (same discounted 0.025x
  // cache-read multiplier). Invite-only, same Project Glasswing limited
  // availability as claude-mythos-5.
  'claude-mythos-5-1': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    thinkingPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  // Opus 5.5 is the newest Opus: $4/$20 (below Opus 5's $5/$25), with cache
  // reads at 0.05x input ($0.20) rather than the usual 0.1x. 5m cache write
  // is the standard 1.25x ($5).
  'claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    thinkingPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 5,
    contextWindow: 1_000_000,
  },
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'claude-opus-4-8': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  // $2/$10 is Anthropic's standing price, not introductory — the "What's new
  // in Claude Sonnet 5" doc states this rate plainly with no mention of a
  // scheduled increase. (An earlier revision of this file said this was
  // introductory pricing set to expire 2026-08-31; that framing was wrong.)
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    thinkingPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  // Same rates as claude-sonnet-5.
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    thinkingPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 2.5,
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
  // Haiku 5.5 is priced by prompt length, flat: a prompt over 100k tokens bills
  // the whole request at 5x input/output and 5x cache reads (platform.claude.com
  // pricing, verified 2026-10-08). The 5m cache-write tier rate ($0.625 above
  // 100k) is not modeled; cache writes stay at the base $0.125. 1M context per
  // the model overview. 'claude-haiku-4' deliberately stays on 4.5.
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    thinkingPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheCreationPerMTok: 0.125,
    contextWindow: 1_000_000,
    tierThreshold: 100_000,
    tierInputPerMTok: 0.5,
    tierOutputPerMTok: 2.5,
    tierThinkingPerMTok: 2.5,
    tierCacheReadPerMTok: 0.05,
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
  // Anthropic lists retirement "not sooner than" 2026-10-15; recheck the
  // deprecations page on or after that date.
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheCreationPerMTok: 1.25,
    contextWindow: 200_000,
  },

  // ---- Anthropic (legacy Claude 4 generation) ----
  // These legacy entries are retained for historical-cost backfill. Most use
  // the pre-1M-context window (200K); claude-opus-4-7 and claude-opus-4-6
  // both have the 1M-context window (confirmed via AWS Bedrock docs, which
  // group them with Opus 4.8/5, Sonnet 5/4.6, and Fable 5). Family-name
  // routing (e.g. `claude-opus-4` → current generation) is handled by
  // MODEL_ALIASES.
  'claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'claude-opus-4-6': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    thinkingPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  // Deprecated 2026-09-30, retires 2026-11-30 (replacement claude-sonnet-5-5).
  // Keep for historical-cost backfill after that date.
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
  // This key uses a version-number suffix (-1), not an 8-digit date suffix,
  // so DATED_SUFFIX_RE never strips it — it's ineligible as a reverse-prefix
  // base. A future 'claude-opus-4-10' resolves via the dated-key + alias path
  // instead (see pricing.test.ts "13b"), never through this entry — no
  // action needed here when that model ships.
  // Retired (tentative 2026-08-05 per Anthropic's deprecations page). Kept for
  // historical-cost backfill.
  'claude-opus-4-1': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    thinkingPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
  // Retired 2026-06-15. Kept for historical-cost backfill.
  'claude-sonnet-4-20250514': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    thinkingPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  // Retired 2026-06-15. Kept for historical-cost backfill.
  'claude-opus-4-20250514': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    thinkingPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
  // Retired 2026-02-19. Kept for historical-cost backfill.
  'claude-haiku-3-5-20241022': {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheCreationPerMTok: 1,
    contextWindow: 200_000,
  },

  // ---- Google Gemini (current generation) ----
  // Gemini 3.6 Flash, 3.7 Flash, and 3.8 Flash are newer generations than 3.5
  // Flash, are the current Flash generation. All three currently
  // carry identical promotional pricing that steps up on 2027-01-01
  // (confirmed directly on ai.google.dev/gemini-api/docs/pricing on
  // 2026-09-02 for 3.8, 2026-08-14 for 3.6/3.7): input $0.75->$1.50, output
  // (incl. thinking) $3.75->$7.50. Rates below are the CURRENT (pre-step-up)
  // rate — update all three to the post-2027-01-01 rate once that date
  // passes. The context-caching read rate steps up the same day, $0.075->$0.15
  // (ai.google.dev, verified 2026-10-08). Cache storage is billed per hour
  // and is not modeled.
  //
  // 3.8 Flash's own model page states its exact input-token limit as
  // 1,048,576, not a round 1,000,000 — contextWindow below is rounded to
  // 1_000_000 to match every sibling Gemini entry's convention in this file.
  'gemini-3.8-flash': {
    inputPerMTok: 0.75,
    cacheReadPerMTok: 0.075,
    outputPerMTok: 3.75,
    thinkingPerMTok: 3.75,
    contextWindow: 1_000_000,
  },
  'gemini-3.7-flash': {
    inputPerMTok: 0.75,
    cacheReadPerMTok: 0.075,
    outputPerMTok: 3.75,
    thinkingPerMTok: 3.75,
    contextWindow: 1_000_000,
  },
  'gemini-3.6-flash': {
    inputPerMTok: 0.75,
    cacheReadPerMTok: 0.075,
    outputPerMTok: 3.75,
    thinkingPerMTok: 3.75,
    contextWindow: 1_000_000,
  },
  'gemini-3.5-flash': {
    inputPerMTok: 1.5,
    cacheReadPerMTok: 0.15,
    outputPerMTok: 9,
    thinkingPerMTok: 9,
    contextWindow: 1_000_000,
  },
  // Gemini 3.5 generation's cost-efficient tier, released alongside 3.5 Flash.
  'gemini-3.5-flash-lite': {
    inputPerMTok: 0.3,
    cacheReadPerMTok: 0.03,
    outputPerMTok: 2.5,
    thinkingPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  'gemini-3.1-pro-preview': {
    inputPerMTok: 2,
    cacheReadPerMTok: 0.2,
    tierCacheReadPerMTok: 0.4,
    outputPerMTok: 12,
    thinkingPerMTok: 12,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 18,
    tierThinkingPerMTok: 18,
  },
  // GA'd and dropped the "-preview" suffix — 'gemini-3.1-flash-lite' (bare)
  // is the current, live model ID; 'gemini-3.1-flash-lite-preview' has been
  // fully SHUT DOWN per ai.google.dev/gemini-api/docs/models (not just
  // deprecated). Same rate, kept below for historical-cost backfill of any
  // consumer still recording events against the old ID.
  //
  // This model and gemini-3-flash-preview below support thinking, and
  // Google bills thinking tokens at the output rate — unlike output,
  // thinking is NOT a subset of it (extractGeminiTokens() reports
  // thoughtsTokenCount as a separate addend), so thinkingPerMTok must be
  // set explicitly or reasoning spend is silently billed at $0.
  'gemini-3.1-flash-lite': {
    inputPerMTok: 0.25,
    audioInputPerMTok: 0.5,
    cacheReadPerMTok: 0.025,
    audioCacheReadPerMTok: 0.05,
    outputPerMTok: 1.5,
    thinkingPerMTok: 1.5,
    contextWindow: 1_000_000,
  },
  'gemini-3.1-flash-lite-preview': {
    inputPerMTok: 0.25,
    audioInputPerMTok: 0.5,
    cacheReadPerMTok: 0.025,
    audioCacheReadPerMTok: 0.05,
    outputPerMTok: 1.5,
    thinkingPerMTok: 1.5,
    contextWindow: 1_000_000,
  },
  'gemini-3-flash-preview': {
    inputPerMTok: 0.5,
    audioInputPerMTok: 1,
    cacheReadPerMTok: 0.05,
    audioCacheReadPerMTok: 0.1,
    outputPerMTok: 3,
    thinkingPerMTok: 3,
    contextWindow: 1_000_000,
  },

  // Gemini Robotics-ER 2 (text-token rates; image/video/audio inputs bill at the
  // same per-token rate). Output price includes thinking tokens. $1/$5 is
  // introductory per ai.google.dev, verified 2026-10-08: Google lists
  // $2/$10 starting 2027-01-01, so bump these rates once that date passes.
  'gemini-robotics-er-2-preview': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    thinkingPerMTok: 5,
    contextWindow: 131_072,
  },

  // ---- Google Gemini 2.5 ----
  'gemini-2.5-pro': {
    inputPerMTok: 1.25,
    cacheReadPerMTok: 0.125,
    tierCacheReadPerMTok: 0.25,
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
    audioInputPerMTok: 1,
    cacheReadPerMTok: 0.03,
    audioCacheReadPerMTok: 0.1,
    outputPerMTok: 2.5,
    thinkingPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  // Thinking-capable — see the thinkingPerMTok note on gemini-3.1-flash-lite
  // above; same reasoning applies here.
  'gemini-2.5-flash-lite': {
    inputPerMTok: 0.1,
    audioInputPerMTok: 0.3,
    cacheReadPerMTok: 0.01,
    audioCacheReadPerMTok: 0.03,
    outputPerMTok: 0.4,
    thinkingPerMTok: 0.4,
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
  // GPT-6 (Astra/Sol/Luna) is OpenAI's newest family. Same flat long-context
  // tiering as GPT-5.5/5.6 (2x input/1.5x output above 272k), plus 2x cached
  // input above 272k (stated on each model page, verified 2026-10-08;
  // tierCacheReadPerMTok). Same 1.25x cache-write multiplier as GPT-5.6 (not
  // modeled — see the GPT-5.6 note below).
  // gpt-6-sol is superseded by gpt-6.1-sol but remains billable.
  'gpt-6-astra': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierCacheReadPerMTok: 2,
    tierInputPerMTok: 20,
    tierOutputPerMTok: 75,
  },
  'gpt-6.1-sol': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.1,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierCacheReadPerMTok: 0.2,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 15,
  },
  'gpt-6-sol': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 15,
  },
  'gpt-6-luna': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierCacheReadPerMTok: 0.02,
    tierInputPerMTok: 0.2,
    tierOutputPerMTok: 0.75,
  },
  // GPT-5.6 (Sol/Terra/Luna) is the prior-generation flagship family,
  // superseded by GPT-6. Same flat long-context tiering as GPT-5.5 (2x
  // input/1.5x output above 272k).
  // Cache writes are billed at 1.25x uncached input on this family — not
  // modeled here: extractOpenAITokens() in tokens.ts hardcodes
  // cacheCreationTokens to 0 (OpenAI's usage shape has no cache-write
  // count), so a cacheCreationPerMTok here would be dead data until that
  // extractor gains a field for it.
  // The GPT-5.5/5.6 pages (verified 2026-10-08) say the >272k tier is "2x
  // input and 1.5x output" and are silent on cached input, so no
  // tierCacheReadPerMTok is set for them (unlike GPT-6, which states 2x
  // "input and cache rates"). Cached input above 272k bills at the base rate.
  // $4/$20 is promotional pricing per OpenAI's own model page: "a 20%
  // reduction in input pricing and a 33% reduction in output pricing"
  // versus GPT-5.5 ($5/$30), "available at least through November 21,
  // 2026." OpenAI does not state what the reverted/list rate would be
  // after that date, or a "% off" figure for Sol itself — re-check
  // against the live model page once that date passes.
  'gpt-5.6-sol': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.4,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 8,
    tierOutputPerMTok: 30,
  },
  'gpt-5.6-terra': {
    inputPerMTok: 2,
    outputPerMTok: 12,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 18,
  },
  'gpt-5.6-luna': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 0.4,
    tierOutputPerMTok: 1.8,
  },
  // A real, separately-priced model — NOT family shorthand for gpt-5.5/5.6.
  // See the MODEL_ALIASES comment above: do not alias bare 'gpt-5' to
  // anything.
  'gpt-5': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    contextWindow: 400_000,
  },
  // OpenAI publishes this directly (platform.openai.com/docs/models/gpt-5-mini)
  // — no longer sourced from GitHub Copilot's pricing page. contextWindow is
  // 400,000, not 128,000: that figure is this model's max OUTPUT tokens, not
  // its context window — an earlier revision conflated the two.
  'gpt-5-mini': {
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.025,
    contextWindow: 400_000,
  },
  // OpenAI publishes this directly too (platform.openai.com/docs/models/gpt-5.3-codex)
  // — no longer sourced from GitHub Copilot's pricing page.
  'gpt-5.3-codex': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    contextWindow: 400_000,
  },
  // Prior-generation flagship, superseded by gpt-5.6-sol and GPT-6 but still
  // billable at these rates.
  'gpt-5.5': {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheReadPerMTok: 0.5,
    contextWindow: 1_050_000,
    // 'flat' tier mode (the default — see ModelPricing.tierMode): once
    // inputTokens > 272k, the ENTIRE request re-prices at 2x input / 1.5x
    // output, per OpenAI's own model page ("priced at 2x input and 1.5x
    // output for the full request"). An earlier revision of this file
    // modeled this as 'marginal' (excess-tokens-only, no output tiering) —
    // that was wrong on three counts: mode, threshold (270k vs 272k), and
    // the missing output multiplier.
    tierThreshold: 272_000,
    tierInputPerMTok: 10,
    tierOutputPerMTok: 45,
  },
  'gpt-5.4': {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.25,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 5,
    tierOutputPerMTok: 22.5,
  },
  'gpt-5.4-mini': {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.075,
    contextWindow: 400_000,
  },
  'gpt-5.4-nano': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.25,
    cacheReadPerMTok: 0.02,
    contextWindow: 400_000,
  },

  // ---- OpenAI (current-generation catalog gaps, added per issue #47) ----
  // Text-token models only; audio/image/TTS/embedding SKUs are out of scope.
  // Rates verified against developers.openai.com/api/docs/pricing.md and each
  // model page on 2026-10-08. The -pro models re-price the full request above
  // 272k input, same flat-tier mode as gpt-5.5.
  // gpt-5.5-cyber is deliberately absent: its model page publishes no context window.
  'gpt-5.5-pro': {
    inputPerMTok: 30,
    outputPerMTok: 180,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 60,
    tierOutputPerMTok: 270,
  },
  'gpt-5.4-pro': {
    inputPerMTok: 30,
    outputPerMTok: 180,
    contextWindow: 1_050_000,
    tierThreshold: 272_000,
    tierInputPerMTok: 60,
    tierOutputPerMTok: 270,
  },
  'gpt-5.2': {
    inputPerMTok: 1.75,
    outputPerMTok: 14,
    cacheReadPerMTok: 0.175,
    contextWindow: 400_000,
  },
  'gpt-5.2-pro': {
    inputPerMTok: 21,
    outputPerMTok: 168,
    contextWindow: 400_000,
  },
  // Shutdown 2027-04-01 per OpenAI; keep for historical-cost backfill after.
  'gpt-5.1': {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.125,
    contextWindow: 400_000,
  },
  'gpt-5-nano': {
    inputPerMTok: 0.05,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.005,
    contextWindow: 400_000,
  },
  'gpt-5-pro': {
    inputPerMTok: 15,
    outputPerMTok: 120,
    contextWindow: 400_000,
  },
  'gpt-5.6-cyber': {
    inputPerMTok: 12.5,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.25,
    contextWindow: 400_000,
  },
  'gpt-4.1': {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    contextWindow: 1_047_576,
  },
  'gpt-4.1-mini': {
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cacheReadPerMTok: 0.1,
    contextWindow: 1_047_576,
  },
  'gpt-4.1-nano': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.025,
    contextWindow: 1_047_576,
  },
  'o1-pro': {
    inputPerMTok: 150,
    outputPerMTok: 600,
    contextWindow: 200_000,
  },
  'o3-pro': {
    inputPerMTok: 20,
    outputPerMTok: 80,
    contextWindow: 200_000,
  },
  'gpt-4o-2024-05-13': {
    inputPerMTok: 5,
    outputPerMTok: 15,
    contextWindow: 128_000,
  },
  'gpt-4-0613': {
    inputPerMTok: 30,
    outputPerMTok: 60,
    contextWindow: 8_192,
  },
  'gpt-3.5-turbo-instruct': {
    inputPerMTok: 1.5,
    outputPerMTok: 2,
    contextWindow: 4_096,
  },
  // Deprecated: gpt-4.1-nano, o1-pro, gpt-4o-2024-05-13 and gpt-4-0613 shut down
  // 2026-10-23; gpt-5-pro and o3-pro 2026-12-11. Kept for historical-cost backfill.

  // ---- OpenAI (legacy) ----
  // gpt-4o/-mini and their dated snapshots below all publish a cached-input
  // rate (~50% off list, notably less generous than the ~90% discount on
  // newer models) — cacheReadPerMTok was previously omitted on all of them,
  // which meant computeCost()'s `?? 0` fallback priced cached reads as
  // free and overstated cache savings.
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    contextWindow: 128_000,
  },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
    contextWindow: 128_000,
  },
  'gpt-4o-2024-11-20': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    contextWindow: 128_000,
  },
  'gpt-4o-2024-08-06': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    contextWindow: 128_000,
  },
  'gpt-4o-mini-2024-07-18': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
    contextWindow: 128_000,
  },
  o1: {
    inputPerMTok: 15,
    outputPerMTok: 60,
    cacheReadPerMTok: 7.5,
    // No thinkingPerMTok: OpenAI bills reasoning tokens as part of
    // completion_tokens at outputPerMTok. The extractor sets thinkingTokens
    // from completion_tokens_details.reasoning_tokens as an informational
    // breakdown, but those tokens are already counted in outputTokens, so
    // a separate thinkingPerMTok rate would double-bill.
    contextWindow: 200_000,
  },
  // o1-mini and o1-preview were fully shut down by OpenAI (2025-10-27 and
  // 2025-07-28 respectively) — requests to these model IDs now fail.
  // Retained only for historical-cost backfill, same convention as
  // gemini-2.0-flash (above) / command / command-light (below).
  'o1-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.55,
    contextWindow: 128_000,
  },
  'o1-preview': {
    inputPerMTok: 15,
    outputPerMTok: 60,
    cacheReadPerMTok: 7.5,
    contextWindow: 128_000,
  },
  // Repriced down from its April 2025 launch rate ($10/$40) — $2/$8 is the
  // current rate, confirmed against the live model page.
  o3: {
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    // No thinkingPerMTok — see 'o1' comment above.
    contextWindow: 200_000,
  },
  'o3-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.55,
    contextWindow: 200_000,
  },
  'o4-mini': {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.275,
    contextWindow: 200_000,
  },
  // gpt-4-turbo and gpt-3.5-turbo (and o1, o3-mini, o4-mini above) are on
  // OpenAI's deprecations page with a 2026-10-23 shutdown. Keep for
  // historical-cost backfill after that date.
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
  // Cache pricing for these models is published on the Bedrock pricing
  // page — resolved by matching
  // each model's known direct-API cache-write/-read multipliers (1.25x /
  // 0.1x of input), which line up exactly with AWS's own numbers. AWS
  // publishes BOTH a 5-minute and a 1-hour cache-write rate; cacheCreationPerMTok
  // here is the 5-minute rate (matches the direct-API default TTL) — there's
  // no field for the 1-hour rate, which would need a schema change to model.
  // $2/$10 is Anthropic's standing Sonnet 5 price on Bedrock too — not
  // introductory. See the direct-API claude-sonnet-5 comment above.
  //
  // Bare `anthropic.*` keys below (and the regional-prefix
  // aliases (us./eu./au./jp./in./apac.) in MODEL_ALIASES) price the "Geo and
  // In-region Cross-region Inference" tier — AWS bills these two identically. The `global.*` keys
  // further down price the separate, ~10%-cheaper "Global Cross-region
  // Inference" tier. On Bedrock a bare `anthropic.*` ID is genuinely the
  // in-region on-demand ID (confirmed real and directly invocable for this
  // generation — no date/version suffix required, unlike the legacy models
  // below), so pricing it at the global rate (an earlier revision did this)
  // was a real bug, not just a rounding choice.
  //
  // Geo/in-region rate = 1.1x the global rate, confirmed exactly on
  // claude-sonnet-5 via AWS's own per-SKU pricing data ($2.2/$11/cw$2.75/
  // cr$0.22 vs. global's $2/$10/cw$2.5/cr$0.2) and independently corroborated
  // as AWS's documented flat ~10% policy (not model-specific) on the
  // global-cross-region-inference docs page. Some pre-5.5
  // models' geo rates below were originally DERIVED via that same 1.1x
  // multiplier; entries annotated as read from AWS's pricing page have since
  // been read directly. Re-confirm the rest in the next full audit pass.
  'anthropic.claude-sonnet-5': {
    inputPerMTok: 2.2,
    outputPerMTok: 11,
    cacheReadPerMTok: 0.22,
    cacheCreationPerMTok: 2.75,
    contextWindow: 1_000_000,
  },
  // Sonnet 5.5 and Opus 5.5 geo rates are read directly from AWS's pricing
  // page (2026-10-07), not derived from the 1.1x multiplier. Model IDs
  // confirmed against AWS's model cards (2026-10-07).
  'anthropic.claude-sonnet-5-5': {
    inputPerMTok: 2.2,
    outputPerMTok: 11,
    cacheReadPerMTok: 0.22,
    cacheCreationPerMTok: 2.75,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-5-5': {
    inputPerMTok: 4.4,
    outputPerMTok: 22,
    cacheReadPerMTok: 0.22,
    cacheCreationPerMTok: 5.5,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-fable-5': {
    inputPerMTok: 11,
    outputPerMTok: 55,
    cacheReadPerMTok: 1.1,
    cacheCreationPerMTok: 13.75,
    contextWindow: 1_000_000,
  },
  // Geo rate read from AWS's pricing page (2026-10-07).
  'anthropic.claude-fable-5-1': {
    inputPerMTok: 11,
    outputPerMTok: 55,
    cacheReadPerMTok: 0.275,
    cacheCreationPerMTok: 13.75,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-5': {
    inputPerMTok: 5.5,
    outputPerMTok: 27.5,
    cacheReadPerMTok: 0.55,
    cacheCreationPerMTok: 6.875,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-4-8': {
    inputPerMTok: 5.5,
    outputPerMTok: 27.5,
    cacheReadPerMTok: 0.55,
    cacheCreationPerMTok: 6.875,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-4-7': {
    inputPerMTok: 5.5,
    outputPerMTok: 27.5,
    cacheReadPerMTok: 0.55,
    cacheCreationPerMTok: 6.875,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-sonnet-4-6': {
    inputPerMTok: 3.3,
    outputPerMTok: 16.5,
    cacheReadPerMTok: 0.33,
    cacheCreationPerMTok: 4.125,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputPerMTok: 1.1,
    outputPerMTok: 5.5,
    cacheReadPerMTok: 0.11,
    cacheCreationPerMTok: 1.375,
    contextWindow: 200_000,
  },
  // Haiku 5.5: IDs from its AWS model card, rates from the AWS pricing page (2026-10-07).
  'anthropic.claude-haiku-5-5': {
    inputPerMTok: 0.11,
    outputPerMTok: 0.55,
    cacheReadPerMTok: 0.011,
    cacheCreationPerMTok: 0.1375,
    contextWindow: 1_000_000,
  },
  // Older and Mythos-line Claude models, geo/in-region rates read from AWS's
  // pricing page (2026-10-07); IDs confirmed against AWS model cards except
  // Mythos Preview, Opus 4, 3.7 Sonnet and 3 Sonnet (no card; AWS still prices them).
  // Mythos 5 is bedrock-mantle (Messages API) only, with no Geo or Global profile.
  'anthropic.claude-mythos-5': {
    inputPerMTok: 11,
    outputPerMTok: 55,
    cacheReadPerMTok: 1.1,
    cacheCreationPerMTok: 13.75,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-mythos-5-1': {
    inputPerMTok: 11,
    outputPerMTok: 55,
    cacheReadPerMTok: 0.275,
    cacheCreationPerMTok: 13.75,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-mythos-preview': {
    inputPerMTok: 27.5,
    outputPerMTok: 137.5,
    cacheReadPerMTok: 2.75,
    cacheCreationPerMTok: 34.375,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-4-6-v1': {
    inputPerMTok: 5.5,
    outputPerMTok: 27.5,
    cacheReadPerMTok: 0.55,
    cacheCreationPerMTok: 6.875,
    contextWindow: 1_000_000,
  },
  'anthropic.claude-opus-4-5-20251101-v1:0': {
    inputPerMTok: 5.5,
    outputPerMTok: 27.5,
    cacheReadPerMTok: 0.55,
    cacheCreationPerMTok: 6.875,
    contextWindow: 200_000,
  },
  'anthropic.claude-sonnet-4-5-20250929-v1:0': {
    inputPerMTok: 3.3,
    outputPerMTok: 16.5,
    cacheReadPerMTok: 0.33,
    cacheCreationPerMTok: 4.125,
    contextWindow: 200_000,
  },
  'anthropic.claude-sonnet-4-20250514-v1:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  'anthropic.claude-opus-4-1-20250805-v1:0': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
  'anthropic.claude-opus-4-20250514-v1:0': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheCreationPerMTok: 18.75,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-7-sonnet-20250219-v1:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-haiku-20240307-v1:0': {
    inputPerMTok: 0.25,
    outputPerMTok: 1.25,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-sonnet-20240229-v1:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 200_000,
  },
  // Global Cross-region Inference tier for the Bedrock Claude models
  // above — ~10% cheaper, see the tier comment there. Real, directly
  // invocable Bedrock model IDs (confirmed via AWS's model-card pages), not
  // this table's own naming convention.
  'global.anthropic.claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 2.5,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheCreationPerMTok: 5,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-fable-5': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-opus-4-8': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheCreationPerMTok: 1.25,
    contextWindow: 200_000,
  },
  'global.anthropic.claude-opus-4-6-v1': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-opus-4-5-20251101-v1:0': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
    contextWindow: 200_000,
  },
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  'global.anthropic.claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheCreationPerMTok: 0.125,
    contextWindow: 1_000_000,
  },
  // Fable 5.1 and Mythos 5.1: AWS model cards confirm these global IDs exist, but
  // the pricing page lists no Global-tier row. Rates are DERIVED from the geo row
  // via AWS's flat 1.1x geo premium; replace with published rates when AWS lists them.
  'global.anthropic.claude-fable-5-1': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  'global.anthropic.claude-mythos-5-1': {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheCreationPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  // Sonnet 4 is priced identically in the Geo and Global tiers on the AWS page.
  'global.anthropic.claude-sonnet-4-20250514-v1:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  // Legacy Claude models via Bedrock cross-region inference
  // Cache rates verified against AWS Bedrock pricing page (2026-06-03) — but
  // against the WRONG table. AWS publishes two tiers for this model: the
  // standard $3/$15 tier (cache write $3.75, cache read $0.30 — used below,
  // paired with this entry's standard input/output rate) and a separate "Public Extended Access, Effective 1
  // Dec 2025" tier at exactly 2x ($6/$30, cache write $7.50, cache read
  // $0.60) for accounts still on this model post-EOL. The 2026-06-03 check
  // paired the standard input/output with the extended-access cache rates
  // by mistake — the fix here re-derives cache write/read directly from
  // AWS's own pricing data for the SAME standard-tier row as the existing
  // $3/$15 (resolved via aws.amazon.com/bedrock/pricing's client-side price
  // placeholders on 2026-08-14, not inferred), so it's internally
  // consistent again. If callers are actually on Public Extended Access —
  // undetectable from usage data alone — the whole entry (not just the
  // cache rates) would need to move to the $6/$30 row instead; not done here.
  'anthropic.claude-3-5-sonnet-20241022-v2:0': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
    contextWindow: 200_000,
  },
  // Cache pricing for this model is published on the Bedrock pricing
  // page — same 1.25x-input /
  // 0.1x-input multiplier convention used everywhere else in this section.
  'anthropic.claude-3-5-haiku-20241022-v1:0': {
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheCreationPerMTok: 1.0,
    contextWindow: 200_000,
  },
  'anthropic.claude-3-opus-20240229-v1:0': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    contextWindow: 200_000,
  },
  // Meta Llama via Bedrock
  // Llama 3 (both sizes) has an 8K context window, not 128K — 128K arrived
  // with Llama 3.1. 70B's rate was also stale: $0.99/$0.99 was actually
  // Llama 3.1 70B's original 2024 launch price (itself since dropped to
  // $0.72/$0.72) — it was never Llama 3 70B's price, which is $2.65/$3.50.
  'meta.llama3-70b-instruct-v1:0': {
    inputPerMTok: 2.65,
    outputPerMTok: 3.5,
    contextWindow: 8_192,
  },
  'meta.llama3-8b-instruct-v1:0': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.6,
    contextWindow: 8_192,
  },
  // Llama 3.1+ / 4 per-MTok rates are us-east-1 on-demand from AWS's pricing
  // page; IDs and context windows confirmed against AWS model cards (2026-10-07).
  'meta.llama4-maverick-17b-instruct-v1:0': {
    inputPerMTok: 0.24,
    outputPerMTok: 0.97,
    contextWindow: 1_000_000,
  },
  'meta.llama4-scout-17b-instruct-v1:0': {
    inputPerMTok: 0.17,
    outputPerMTok: 0.66,
    contextWindow: 10_000_000,
  },
  'meta.llama3-3-70b-instruct-v1:0': {
    inputPerMTok: 0.72,
    outputPerMTok: 0.72,
    contextWindow: 128_000,
  },
  'meta.llama3-2-1b-instruct-v1:0': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.1,
    contextWindow: 128_000,
  },
  'meta.llama3-2-3b-instruct-v1:0': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.15,
    contextWindow: 128_000,
  },
  'meta.llama3-2-11b-instruct-v1:0': {
    inputPerMTok: 0.16,
    outputPerMTok: 0.16,
    contextWindow: 128_000,
  },
  'meta.llama3-2-90b-instruct-v1:0': {
    inputPerMTok: 0.72,
    outputPerMTok: 0.72,
    contextWindow: 128_000,
  },
  'meta.llama3-1-8b-instruct-v1:0': {
    inputPerMTok: 0.22,
    outputPerMTok: 0.22,
    contextWindow: 128_000,
  },
  'meta.llama3-1-70b-instruct-v1:0': {
    inputPerMTok: 0.72,
    outputPerMTok: 0.72,
    contextWindow: 128_000,
  },
  // Mistral via Bedrock
  // Mistral 7B and Pixtral Large rates: us-east-1 on-demand, AWS page (2026-10-07).
  'mistral.mistral-7b-instruct-v0:2': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.2,
    contextWindow: 32_000,
  },
  'mistral.pixtral-large-2502-v1:0': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    contextWindow: 128_000,
  },
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
  // Mistral Large 3 on Bedrock: $0.50/$1.50 per the AWS pricing page, 256K per its model card.
  'mistral.mistral-large-3-675b-instruct': {
    inputPerMTok: 0.5,
    outputPerMTok: 1.5,
    contextWindow: 256_000,
  },
  // Amazon Nova (Premier / 2 Lite added 2026-10-07). Nova Premier has no AWS model
  // card but is still priced on the pricing page; its ID and 1M window are unconfirmed.
  // Cache reads (25% of input) are from the Bedrock pricing page's Nova on-demand
  // table (verified 2026-10-08); the prompt-caching docs list Micro/Lite/Pro/2 Lite
  // as supported. Premier's cache support is unchecked. No cache-write charge seen.
  'amazon.nova-premier-v1:0': {
    inputPerMTok: 2.5,
    outputPerMTok: 12.5,
    contextWindow: 1_000_000,
  },
  'amazon.nova-2-lite-v1:0': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.075,
    contextWindow: 1_000_000,
  },
  'amazon.nova-pro-v1:0': {
    inputPerMTok: 0.8,
    outputPerMTok: 3.2,
    cacheReadPerMTok: 0.2,
    contextWindow: 300_000,
  },
  'amazon.nova-lite-v1:0': {
    inputPerMTok: 0.06,
    outputPerMTok: 0.24,
    cacheReadPerMTok: 0.015,
    contextWindow: 300_000,
  },
  'amazon.nova-micro-v1:0': {
    inputPerMTok: 0.035,
    outputPerMTok: 0.14,
    cacheReadPerMTok: 0.00875,
    contextWindow: 128_000,
  },

  // ---- Mistral ----
  // "-latest" is a real Mistral API alias (currently routes to Mistral
  // Medium 3.5 / Large 3 / Small 4 respectively) — not our own shorthand.
  //
  // Mistral now publishes a cached-input rate (90% off list price) for all
  // of the current-gen entries below, INCLUDING Ministral 3 — but it's not
  // modeled here: extractMistralTokens() in tokens.ts hardcodes
  // cacheReadTokens to 0 (Mistral's Chat Completions usage shape has no
  // cache-hit count today), so a cacheReadPerMTok here would be dead data
  // until that extractor gains a field for it. Same reasoning as the
  // OpenAI GPT-5.6 cache-write omission above.
  'mistral-medium-latest': {
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    contextWindow: 256_000,
  },
  'mistral-large-latest': {
    inputPerMTok: 0.5,
    outputPerMTok: 1.5,
    contextWindow: 256_000,
  },
  // Mistral Large 4 (docs.mistral.ai/models/mistral-large-4-0, v26.10, public
  // preview since 2026-10-06; API names mistral-large-4 / mistral-large-4-0).
  // Rates are the preview SALE price actually billed, verified 2026-10-07:
  // $0.68 in / $2.09 out against a struck-through list of $1.36 / $4.18.
  // TEMPORARY SALE PRICING, no published end date: re-verify at every pricing
  // audit and revert to the list price ($1.36 / $4.18) once the sale ends,
  // otherwise costs are under-reported by half. 'mistral-large-latest' above is
  // deliberately unchanged: the docs don't say it now routes here.
  'mistral-large-4': {
    inputPerMTok: 0.68,
    outputPerMTok: 2.09,
    contextWindow: 1_000_000,
  },
  'mistral-large-4-0': {
    inputPerMTok: 0.68,
    outputPerMTok: 2.09,
    contextWindow: 1_000_000,
  },
  'mistral-small-latest': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 256_000,
  },
  // Ministral 3 family — Mistral's pricing page now shows a "-latest" alias
  // for each size (ministral-3b-latest / -8b-latest / -14b-latest), routed
  // to these dated entries via MODEL_ALIASES above. The dated snapshot ID
  // (as shown on each model's docs page) remains the real, callable model
  // string; "-latest" is Mistral's own shorthand for it.
  'ministral-14b-2512': {
    inputPerMTok: 0.2,
    outputPerMTok: 0.2,
    contextWindow: 256_000,
  },
  'ministral-8b-2512': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.15,
    contextWindow: 256_000,
  },
  'ministral-3b-2512': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.1,
    contextWindow: 256_000,
  },
  // Retired 2026-07-31 (deprecated 2026-05-22) — no longer billable via the
  // Mistral API. Retained for historical-cost backfill only, same
  // convention as gemini-2.0-flash (above) / command / command-light (below).
  // contextWindow unchanged (128k) — this predates the 256k bump the
  // -latest family got later; it was never repriced, only retired.
  'mistral-nemo': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.15,
    contextWindow: 131_072,
  },
  // ---- Mistral (legacy — retired 2025-03-30) ----
  // Both are listed under "Deprecated & retired models" on docs.mistral.ai
  // (checked 2026-10-07). Retained for historical-cost backfill.
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
  // Note: codestral's window (128k) is smaller than the 256k of the current
  // -latest generalist models.
  'codestral-latest': {
    inputPerMTok: 0.3,
    outputPerMTok: 0.9,
    contextWindow: 128_000,
  },

  // ---- Cohere ----
  // Cohere's OWN docs make bare 'command-r'/'command-r-plus' deprecated
  // aliases for the OLDER dated snapshots (command-r-03-2024 at $0.50/$1.50,
  // command-r-plus-04-2024 at $3/$15) — not the current -08-2024 snapshots
  // priced below. This table deliberately keeps 'command-r'/'command-r-plus'
  // as CURRENT-gen shorthand instead (consistent with every other provider's
  // alias philosophy in this file — see the MODEL_ALIASES comment at the top:
  // "a caller passes a family name... they almost always mean the current
  // generation"). If a caller sends the literal Cohere API model string
  // (not shorthand), it resolves to the exact-match dated keys below instead.
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
  // Actual current ("Live") Cohere API model IDs — same rates as the
  // shorthand keys above, added so a caller using the versioned ID gets an
  // exact match instead of falling through to null.
  'command-r-plus-08-2024': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 128_000,
  },
  'command-r-08-2024': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    contextWindow: 128_000,
  },
  'command-r7b-12-2024': {
    inputPerMTok: 0.0375,
    outputPerMTok: 0.15,
    contextWindow: 128_000,
  },
  // Deprecated 2025-09-15 (formal effective date per
  // docs.cohere.com/docs/deprecations) but retained for historical-cost
  // backfill — these are the OLDER snapshots the bare 'command-r'/
  // 'command-r-plus' aliases pointed to before Cohere deprecated them.
  'command-r-plus-04-2024': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 128_000,
  },
  'command-r-03-2024': {
    inputPerMTok: 0.5,
    outputPerMTok: 1.5,
    contextWindow: 128_000,
  },
  // `command` and `command-light` are deprecated (effective 2025-09-15, per
  // docs.cohere.com/docs/deprecations) but retained for historical-cost
  // backfill of consumer apps that haven't migrated.
  // Context window is 4096 tokens, not the round number 4000.
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

  // ---- xAI ----
  // xAI now publishes its own direct pricing (docs.x.ai/developers/pricing),
  // superseding the GitHub Copilot sourcing this entry previously used —
  // Copilot's page still lists this model but its cached-input rate ($0.5)
  // is stale next to xAI's own $0.3.
  'grok-4.5': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.3,
    contextWindow: 500_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.6,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 12,
  },
  // Prior xAI flagship (superseded by grok-4.7), sourced from
  // docs.x.ai/docs/pricing and docs.x.ai/docs/models/grok-4.6 — same $2/$6 base and 200K flat
  // long-context tier shape as grok-4.5, but a higher cached-input rate
  // ($0.5 base / $1 long-context tier, vs 4.5's $0.3/$0.6).
  'grok-4.6': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    contextWindow: 500_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 1,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 12,
  },
  // Verified 2026-10-07 against docs.x.ai/developers/pricing. Every entry
  // below has the same long-context (xAI: ">= 200k"; computeCost tiers
  // strictly above 200_000 input tokens) flat tier as grok-4.5, with
  // the cached-input rate doubled in that tier (tierCacheReadPerMTok).
  // Grok 4.7 Fast and the 1.1x US-regional multiplier on the xAI page are
  // separate SKUs (Cursor/Grok Build only; regional endpoint) — not modeled.
  'grok-4.7': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    contextWindow: 500_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 1,
    tierInputPerMTok: 4,
    tierOutputPerMTok: 12,
  },
  'grok-build-0.1': {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.2,
    contextWindow: 256_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 2,
    tierOutputPerMTok: 4,
  },
  'grok-4.3': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 5,
  },
  'grok-4.20-0309-reasoning': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 5,
  },
  'grok-4.20-0309-non-reasoning': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 5,
  },
  'grok-4.20-multi-agent-0309': {
    inputPerMTok: 1.25,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.2,
    contextWindow: 1_000_000,
    tierThreshold: 200_000,
    tierMode: 'flat',
    tierCacheReadPerMTok: 0.4,
    tierInputPerMTok: 2.5,
    tierOutputPerMTok: 5,
  },

  // ---- Moonshot AI ----
  // Moonshot publishes direct pricing at platform.moonshot.ai/docs/pricing/chat
  // (rates agree with GitHub Copilot's Moonshot table). K3 also bills cache
  // writes separately by TTL (5min $3.00 / 1h $6.00, published on the
  // context-caching guide, verified 2026-10-08). extractOpenAITokens() reads
  // the usage object's single cache_write_tokens count into cacheCreationTokens
  // and bills it at the 5min rate. The 1h TTL ($6.00) is not modeled: the TTL
  // split is only in response headers, so 1h writes under-price by $3.00/MTok.
  // GitHub's retirement table removes Kimi K2.7 Code from Copilot on 2026-10-02,
  // but Moonshot's direct page still lists it, so the entry stays.
  'kimi-k2.7-code': {
    inputPerMTok: 0.95,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.19,
    contextWindow: 262_144,
  },
  'kimi-k3': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3,
    contextWindow: 1_048_576,
  },

  // kimi-k2.7-code-highspeed and kimi-k2.6 verified 2026-10-07 against the
  // same page (column headers: cache hit / cache miss / output).
  'kimi-k2.7-code-highspeed': {
    inputPerMTok: 1.9,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.38,
    contextWindow: 262_144,
  },
  'kimi-k2.6': {
    inputPerMTok: 0.95,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.16,
    contextWindow: 262_144,
  },

  // ---- Microsoft (MAI-Code) ----
  // Sourced from GitHub Copilot's pricing page (see the file-level comment
  // above) — Microsoft has no separate public per-token pricing page for
  // the MAI-Code family.
  // No longer on Copilot's pricing page (only mai-code-1.1-flash is, checked
  // 2026-10-07) — likely superseded. Retained for historical-cost backfill.
  'mai-code-1-flash': {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    cacheReadPerMTok: 0.075,
    contextWindow: 128_000,
  },
  // contextWindow unverified: neither Copilot nor Microsoft publishes one for the
  // hosted model. Microsoft's launch post cites 256K for the on-device build only.
  'mai-code-1.1-flash': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    contextWindow: 128_000,
  },

  // ---- GitHub (Copilot fine-tuned) ----
  // Raptor mini is GitHub's own fine-tuned model, billed only through
  // Copilot — there is no vendor page to source it from other than Copilot's
  // own pricing page (see the file-level comment above). No longer listed
  // there as of 2026-10-07 — likely delisted. Retained for historical-cost
  // backfill.
  'raptor-mini': {
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.025,
    contextWindow: 128_000,
  },
};
