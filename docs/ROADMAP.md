# NR AI Coding Observability — Roadmap

This document captures the planned post-launch roadmap items referenced throughout [PRODUCT_BRIEF.md](./PRODUCT_BRIEF.md). It is intended to evolve — items may be reprioritised, scoped, or delivered in different waves than initially proposed.

As a New Relic Labs asset, the cadence and prioritisation here will follow Labs-team workflows (GitHub issues, Labs Work Items, the `#help-labs-dev` Slack channel) rather than core-product release cycles.

---

## Table of Contents

[Recommendation Engine Maturation](#recommendation-engine-maturation)

[Platform Adapter Set Expansion](#platform-adapter-set-expansion)

[Audit and Compliance Surface Extension](#audit-and-compliance-surface-extension)

[IDE-Embedded Surfaces](#ide-embedded-surfaces)

[Enterprise Controls](#enterprise-controls)

[OpenTelemetry GenAI Convention Compliance](#opentelemetry-genai-convention-compliance)

[Cold-Start UX for Net-New Users](#cold-start-ux-for-net-new-users)

[Pre-Deployment Consumption Estimation](#pre-deployment-consumption-estimation)

---

## Recommendation Engine Maturation

The launch-set product surfaces anti-pattern detection and a basic personal coaching report. Future iterations will deepen this into a true recommendation engine.

**Planned work:**

- Deeper personal coaching that generates concrete, actionable optimisation guidance per developer (e.g. "your sessions in this codebase consistently re-read these files; consider adding them to a CLAUDE.md")
- Team-level recommendations that surface high-performing usage patterns and propagate them to other team members
- Machine-learning-based pattern detection to surface anti-patterns and optimisation opportunities that aren't expressible in rule-based detectors
- Per-AI-tool model recommendations (e.g. "you are using Claude Sonnet for short exploratory sessions where Claude Haiku would cost 25× less")

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape) (closing note), [§7 — Mindset Shift & Risks](./PRODUCT_BRIEF.md#7--mindset-shift--risks) (mindset shift caveat), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope)

---

## Platform Adapter Set Expansion

Launch coverage targets eight AI coding clients (Claude Code, Cursor, Windsurf, Copilot, Zed, Continue.dev, Amazon Q, generic MCP). The AI coding tooling space is fragmenting rapidly, so adapter coverage is an ongoing investment.

**Planned work:**

- At least two additional AI client adapters delivered between Public Preview and GA, prioritised by customer demand signal
- Ongoing adapter cadence after GA to keep coverage gap below ~6 months for popular new AI tools
- Adapter contribution model so customers and the open-source community can submit adapters for tools we haven't covered

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #9), [§13 — Additional Flags](./PRODUCT_BRIEF.md#13--additional-flags) (AI tooling velocity risk)

---

## Audit and Compliance Surface Extension

Launch coverage captures sensitive file access, destructive command execution, and external network requests. Future work extends this surface to track an expanding regulatory landscape (EU AI Act, analogous regulations elsewhere).

**Planned work:**

- Expand the audit event schema to cover additional regulated activities as compliance frameworks specify them
- Provide compliance-report templates (NRQL queries and dashboards) for common audit asks
- Inherit and document applicable platform compliance certifications (SOC 2 Type II, ISO 27001) as they apply to the underlying New Relic platform
- Configurable retention policies aligned with customer compliance requirements (90 / 180 / 365-day retention defaults already supported; expand as needed)

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape) (closing note), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #7)

---

## IDE-Embedded Surfaces

Launch coverage surfaces telemetry through MCP tools, dashboards, alerts, and (eventually) the New Relic UI. A natural next step is in-IDE visibility so developers see their own coaching insights without leaving their editor.

**Planned work:**

- CodeStream integration to surface personal coaching, anti-pattern history, and recent session metrics directly inside the IDE
- Inline cost estimation as a developer works (predict the cost of the current session based on recent activity)

**Brief references:** [§8 — Discovery & Access](./PRODUCT_BRIEF.md#8--discovery--access) (in-platform surfaces), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope)

---

## Enterprise Controls

The product respects existing New Relic RBAC and supports a high-security mode that disables content capture entirely. Full enterprise-tier readiness still requires additional integration work.

**Planned work:**

- RBAC integration for fine-grained access control over AI Observatory data (per-team data isolation, per-developer view restrictions)
- Per-team data isolation guarantees for multi-tenant customer accounts
- Configurable redaction policies beyond the current `DEFAULT_REDACTION_PATTERNS` set

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves) (Standard Enterprise Controls), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #8)

---

## OpenTelemetry GenAI Convention Compliance

Span attributes already follow OpenTelemetry GenAI semantic conventions for portability. Future work formalises that compliance.

**Planned work:**

- Formal certification of span attributes against OpenTelemetry GenAI semantic conventions
- OTLP export documentation and integration guides for customers running additional observability platforms alongside New Relic
- Stay current with OTel GenAI convention revisions as the spec evolves

**Brief references:** [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #6), [Appendix A](./PRODUCT_BRIEF.md#appendix-a--high-level-public-facing-apis)

---

## Cold-Start UX for Net-New Users

After [auditing the backfill script](./PRODUCT_BRIEF.md#resolved-backfill-is-state-recovery-not-new-user-onboarding-was-oq4), it is clear that the script's purpose is state recovery for existing telemetry, not seeding new users with synthetic data. Net-new customers accumulate session data over roughly two weeks before personal coaching reports become useful — this is correct behaviour, not a bug. The roadmap work here is around making the warm-up period a great experience rather than a confusing dead zone.

**Planned work:**

- Surface the warm-up window prominently in the setup wizard and onboarding documentation, with concrete guidance on what to expect during the first two weeks
- Show partial / progressive coaching reports during warm-up — for example, "you have 3 days of data so far; here's what we can already say, and what we'll be able to say in N more days"
- Add an MCP tool surface (e.g. `nr_observe_get_warmup_status`) that lets clients check warm-up progress at a glance

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves), [§8 — Discovery & Access](./PRODUCT_BRIEF.md#8--discovery--access)

---

## Pre-Deployment Consumption Estimation

The brief asserts in [§6 — Clear Consumption Communication](./PRODUCT_BRIEF.md#6--user-must-haves) and [§7 — Consumption Surprises](./PRODUCT_BRIEF.md#7--mindset-shift--risks) that the setup wizard *should* help a customer estimate the ingest volume — and the resulting New Relic bill — that their chosen instrumentation will produce, before they deploy it. That capability does not exist today. Without it, customers face a real risk of unexpected NR consumption costs after rolling out broadly.

**Planned work:**

- Build a pre-deployment estimator into the setup wizard / CLI that takes the customer's intended instrumentation scope (which AI clients, how many developers, expected sessions per developer per day) and produces a projected daily / monthly ingest volume
- Translate that ingest projection into an estimated New Relic platform cost using the customer's plan (or a per-account-tier default)
- Surface the estimate at every opt-in step, so a customer toggling on "instrument the entire platform team" sees the bill impact before committing
- Provide a post-deployment reconciliation: the wizard's first-week summary should compare actual ingest to the projection so the model can be improved

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves) (Clear Consumption Communication), [§7 — Mindset Shift & Risks](./PRODUCT_BRIEF.md#7--mindset-shift--risks) (Consumption Surprises)

---

## Notes

- This roadmap is not committed; items may shift or drop based on customer feedback during Customer Zero, Design-Partner Validation, and the Initial Labs Publication phases (see [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan)).
- Each themed area above maps to one or more issues / milestones in the GitHub repository once published; this document is the human-readable narrative version.
- The brief's [Decisions](./PRODUCT_BRIEF.md#open-questions) section captures the resolved positioning questions (free via Labs, no entitlement, Labs publication workflow, etc.) that shaped this roadmap.
