# Copilot pricing overlay

`pricing.json` fills gaps in the vendored `src/shared/pricing-data.ts` table
for model IDs that GitHub Copilot (CLI/SDK/VS Code) reports but the vendored
table doesn't resolve — confirmed live via `PricingTable.resolve()`'s four
resolution paths (exact / alias / forward-prefix / reverse-prefix), e.g.
`raptor-mini` currently falls through to `null` → `$0` cost.

GitHub Copilot's per-token pricing is a verified passthrough of the
underlying vendor's direct API list price (checked against the vendored
table for `claude-opus-4-8`, `claude-sonnet-5`'s exact promotional rate +
expiry date, `gpt-5.4`, `gpt-5.5` — all exact matches), so these entries are
sourced directly from GitHub's own published rates, not a separate
Copilot-specific markup.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>
(machine-readable via `https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing`)
**Fetched:** 2026-08-12

Only confirmed-missing model IDs are included here — existing vendored
entries are never duplicated or corrected in this file (out of scope; would
need an upstream fix). `contextWindow` values are non-billing-critical
best-effort defaults (not used in `computeCost()`'s pricing math, only
validated as a positive integer) and are not verified against a per-model
context-limit source.

**Known, unavoidable limitations** (inherited from `ModelPricing`'s shape,
which this overlay reuses as-is — not fixable without editing vendored code):

- `ModelPricing` has no tiered cache-read field at all, so `grok-4.5`'s
  doubled long-context _cached-input_ rate cannot be represented; the
  default (lower) cache rate is used at every tier.

**Interaction with a user's own custom pricing file:** if you set
`NEW_RELIC_AI_CUSTOM_PRICING_FILE` (or `customPricingFile` in
`~/.newrelic-preflight/config.json`) to your own pricing file — for _any_
reason, even one unrelated to Copilot — this bundled overlay is not applied
at all. `initPricing()` always replaces the full table from
`DEFAULT_PRICING_TABLE`; it never merges a user's file with this overlay.
If you rely on both a custom pricing entry and one of the gap-fill models
above, add the model you need from `pricing.json` into your own custom
pricing file instead.
