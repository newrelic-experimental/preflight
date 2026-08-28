# Pricing overlay

`pricing.json` fills gaps in the vendored `src/shared/pricing-data.ts` table
for model IDs a platform reports that the vendored table doesn't resolve —
confirmed live via `PricingTable.resolve()`'s four resolution paths (exact /
alias / forward-prefix / reverse-prefix). It's applied automatically at
startup (`applyPricingOverlay()` in `src/metrics/pricing-overlay.ts`) unless
a user has configured their own custom pricing file, and is gap-fill-only:
`applyGapFilledOverlay()` drops any entry that already resolves against the
vendored table instead of overriding it, so it can never silently mask a
correction made upstream.

It's currently empty (`{}`). This isn't tied to any one platform — add an
entry here whenever you hit a real model ID that Preflight resolves to `$0`
cost because the vendored table doesn't have it yet, regardless of which
platform surfaced it.

## Adding an entry

1. Find the model's real per-token rate from a source you can cite — the
   vendor's own pricing page where one exists, or (for models only listed
   through a specific platform, e.g. one a coding assistant surfaces that
   the underlying model vendor doesn't itself document standalone) that
   platform's own published pricing page. Note your source and the date you
   checked it in your commit or PR description — pricing pages change
   without much notice.
2. Add the entry to `pricing.json`, matching the `ModelPricing` shape
   (`src/shared/pricing.ts`). Only add IDs confirmed missing from the
   vendored table — never duplicate or "correct" an existing vendored entry
   here; that needs a fix upstream, in whatever repo maintains
   `src/shared/pricing-data.ts` for you.
3. `contextWindow` is a non-billing-critical best-effort default (not used
   in `calculateCost()`'s pricing math, only validated as a positive
   integer) — it's fine to estimate it if you can't verify it precisely.

This file is exactly the place to add an entry if you can't push directly to
wherever the vendored table's source lives (e.g. an external contributor) —
a maintainer with access can upstream it later, and the collision guard
above makes that safe even if the sync lags.

## Known, unavoidable limitation

Inherited from `ModelPricing`'s shape, which this overlay reuses as-is — not
fixable here without a schema change upstream: `ModelPricing` has no tiered
cache-read field, so a model whose cached-input rate is _higher_ at its
long-context tier than at its default tier can't have that modeled — the
base (lower) cache rate would apply at every tier. If you hit this, note it
explicitly as a comment on the entry.

## Interaction with a user's own custom pricing file

If a user sets `NEW_RELIC_AI_CUSTOM_PRICING_FILE` (or `customPricingFile` in
`~/.newrelic-preflight/config.json`) — for _any_ reason, even one unrelated
to this overlay — it's not applied at all. `initPricing()` always replaces
the full table from `DEFAULT_PRICING_TABLE`; it never merges a user's file
with this overlay. A user relying on both a custom pricing entry and one of
the gap-fill models here should add the model they need from `pricing.json`
into their own custom pricing file instead.
