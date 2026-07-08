# NR AI Coding Observability: Preflight — Roadmap

This document captures the planned post-launch roadmap items referenced throughout [PRODUCT_BRIEF.md](./PRODUCT_BRIEF.md). It is intended to evolve — items may be reprioritised, scoped, or delivered in different waves than initially proposed.

As a New Relic Labs asset, the cadence and prioritisation here will follow Labs-team workflows (GitHub issues, Labs Work Items, the `#help-labs-dev` Slack channel) rather than core-product release cycles.

Ratings are on a 1–5 scale: **Difficulty** (1 = straightforward, 5 = significant engineering effort) · **Customer Impact** (1 = minor convenience, 5 = core value driver).

---

## Table of Contents

[Completed](#completed)

[In Progress](#in-progress)

[Not Started](#not-started)

- [Ecosystem Integrations](#ecosystem-integrations)
- [Developer Session Intelligence](#developer-session-intelligence)
- [AI Model Intelligence](#ai-model-intelligence)
- [Cold-Start UX for Net-New Users](#cold-start-ux-for-net-new-users)
- [Recommendation Engine Maturation](#recommendation-engine-maturation)
- [Team Intelligence](#team-intelligence)
- [Pre-Deployment Consumption Estimation](#pre-deployment-consumption-estimation)
- [IDE-Embedded Surfaces](#ide-embedded-surfaces)
- [Enterprise Controls](#enterprise-controls)
- [Platform Adapter Set Expansion](#platform-adapter-set-expansion)
- [Audit and Compliance Surface Extension](#audit-and-compliance-surface-extension)
- [Environmental Impact](#environmental-impact)
- [OpenTelemetry GenAI Convention Compliance](#opentelemetry-genai-convention-compliance)

---

## Completed

Items shipped and no longer on the active roadmap.

- **Session replay** — A scrub-able visual timeline of any session: every file touched, every command run, every edit made. Delivered via `GET /api/sessions/:id/replay`, `replay-analyzer.ts`, and the `SessionTrace` component surfaced in both the Today live tail and the Sessions history view.
- **Deeper personal coaching** — Narrative coaching report comparing weekly metrics to a developer's personal baseline, with concrete actionable guidance. Delivered via `personal-coach.ts`, `GET /api/personal-coach`, and `nr_observe_get_personal_insights`.
- **Per-AI-tool model usage and cost-efficiency breakdown** — Surfaces cost and request counts per model with a most-efficient-model callout. Delivered via `model-usage-tracker.ts`, `GET /api/model-usage`, and the Model Usage panel on the Today view.
- **Platform adapter expansion** — Nine AI coding client adapters shipped at launch: Claude Code, Cursor, Windsurf, GitHub Copilot, Zed, Continue.dev, Amazon Q, Amazon Kiro, and a generic MCP fallback. Exceeds the "at least two additional" target set at roadmap authoring time.
- **Prompt cache health** — `cache_read_tokens` are tracked per token event; `CostTracker`
  aggregates a `cacheHitRate` ratio and `totalCacheSavingsUsd`; `TrendAnalyzer` computes
  `weeklyCacheHitRateTrend` across sessions. The Today dashboard `CacheHealthPanel` shows the
  current session's hit rate with a status pill (excellent / can improve / needs attention),
  total savings, a week-over-week delta chip (↑/↓ Npts vs last week), and concrete
  recommendation text that includes the actual percentage. The `nr_observe_get_prompt_cache_health`
  MCP tool exposes all cache metrics programmatically.

---

## In Progress

Items with meaningful implementation already shipped but with remaining work before the roadmap intent is fully met.

- **Context window pressure timeline** — The roadmap item called for extending context composition from a point-in-time snapshot into a time-series stacked chart showing how the four token categories grow across a session. The snapshot half is done: `context-composition-tracker.ts`, `ContextBar`, and `GET /api/context` are all live. The time-series / stacked-chart extension and the 20%-remaining warning zone are still outstanding. _(Difficulty: 2/5 · Customer Impact: 3/5)_ — [#30](https://github.com/newrelic-experimental/preflight/issues/30)

- **Compute waste metric** — `retry-detector.ts` already emits an `ai.retry.tokens_wasted` metric capturing tokens consumed on retried tool calls. What's missing is surfacing this as an explicit "compute waste" figure in the dashboard and MCP tools, and broadening it to cover anti-pattern tokens (stuck loops, redundant reads) beyond just retries. _(Difficulty: 1/5 · Customer Impact: 3/5)_ — [#31](https://github.com/newrelic-experimental/preflight/issues/31)

- **Prompt cache health — NR-hosted dashboard parity** — shipped as a local-dashboard feature (`CacheHealthPanel` on the Today view) plus the `nr_observe_get_prompt_cache_health` MCP tool, backed by real metrics (`ai.cost.tokens_cache_read`, `ai.cost.tokens_cache_creation`, `ai.cost.cache_savings_usd`). None of the 7 pre-built NR-hosted dashboards surface it yet, so New Relic-mode users only see this insight if they also run the local dashboard. _(Difficulty: 1/5 · Customer Impact: 2/5)_ — [#77](https://github.com/newrelic-experimental/preflight/issues/77)

---

## Not Started

---

### Ecosystem Integrations

The Observatory currently surfaces data through MCP tools, dashboards, and a local web UI. Future work pushes that data into the workflows developers and managers already live in.

**Planned work:**

- **PR / CI comment with AI footprint** — post a summary to the GitHub PR on merge: AI cost, efficiency score, anti-patterns triggered, and models used. Makes AI cost visible to the whole team without a dashboard visit and creates a natural point for engineering culture conversations about AI usage. _(Difficulty: 2/5 · Customer Impact: 4/5)_ — [#39](https://github.com/newrelic-experimental/preflight/issues/39)
- **Cost attribution to work items** — link AI sessions to GitHub Issues, Jira tickets, or Linear tasks via branch name and commit message parsing. Produce cost-per-story, cost-per-sprint, and cost-per-epic views. This is the bridge from AI observability to engineering economics — the question every engineering manager will eventually ask. _(Difficulty: 3/5 · Customer Impact: 5/5)_ — [#40](https://github.com/newrelic-experimental/preflight/issues/40)
- **Billing API reconciliation** — pull actual charges from the Anthropic or OpenAI billing API and reconcile against the Observatory's cost estimates. Surface accuracy deltas and trend them over time. Builds trust in the cost numbers, which is the most common adoption blocker for teams evaluating the tool. _(Difficulty: 3/5 · Customer Impact: 4/5)_ — [#59](https://github.com/newrelic-experimental/preflight/issues/59)
- **Preflight SDK** — a typed npm package (`@newrelic-experimental/preflight-sdk`) giving adapter authors a stable public interface for emitting Preflight-compatible events without reading the internals. Lowers the barrier to new platform integrations and community adapter contributions. _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#73](https://github.com/newrelic-experimental/preflight/issues/73)
- **IDE status bar widget** — surface live session cost and efficiency score in the VS Code / JetBrains status bar, reading directly from the local buffer file. Zero-friction visibility: every glance at the bottom of the editor shows the running tab. _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#58](https://github.com/newrelic-experimental/preflight/issues/58)

---

### Developer Session Intelligence

The Observatory captures every action an AI coding assistant takes but currently surfaces the analysis after the fact. Future work brings intelligence into the session itself — helping developers make better decisions in real time.

**Planned work:**

- **CLAUDE.md auto-suggestions** — analyze per-developer patterns (most-re-read files, recurring anti-patterns, task types that consistently cause thrashing) and generate specific, evidence-based CLAUDE.md additions. Closes the loop from observation to corrective action without requiring the developer to interpret the data themselves. _(Difficulty: 3/5 · Customer Impact: 5/5)_ — [#41](https://github.com/newrelic-experimental/preflight/issues/41)
- **Overload and diminishing returns detection** — detect when a developer's efficiency score is declining over the course of a long session and surface a signal prompting them to take a break or change approach. AI coding tools encourage staying in the loop; this feature gives the AI a reason to push back. _(Difficulty: 2/5 · Customer Impact: 4/5)_ — [#42](https://github.com/newrelic-experimental/preflight/issues/42)
- **Task complexity pre-estimation** — before a task starts, predict token consumption based on similar completed tasks in the developer's history, with a cost range and confidence interval. Sets expectations before they're broken. _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#43](https://github.com/newrelic-experimental/preflight/issues/43)

---

### AI Model Intelligence

The Observatory tracks which models are used and what they cost, but has limited ability to advise on model selection strategy. Future work closes that gap.

**Planned work:**

- **Structured model A/B testing** — let a developer or team declare an experiment ("for the next two weeks, half my sessions use Sonnet, half use Haiku") and have the Observatory randomize, track outcomes by arm, and report cost-efficiency deltas with statistical significance. Turns "I wonder if Haiku is good enough for this" into a real answer. _(Difficulty: 3/5 · Customer Impact: 5/5)_ — [#44](https://github.com/newrelic-experimental/preflight/issues/44)
- **Prompt injection detection** — scan tool outputs (file contents, command results, web responses) for adversarial content patterns that could redirect the AI model. Flag findings in the audit trail and surface them as a security alert category alongside the existing destructive command and sensitive file detection. As AI coding tools operate on larger codebases with third-party dependencies, this becomes a real attack surface. _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#57](https://github.com/newrelic-experimental/preflight/issues/57)

---

### Cold-Start UX for Net-New Users

After [auditing the backfill script](./PRODUCT_BRIEF.md#resolved-backfill-is-state-recovery-not-new-user-onboarding-was-oq4), it is clear that the script's purpose is state recovery for existing telemetry, not seeding new users with synthetic data. Net-new customers accumulate session data over roughly two weeks before personal coaching reports become useful — this is correct behaviour, not a bug. The roadmap work here is around making the warm-up period a great experience rather than a confusing dead zone.

**Planned work:**

- Surface the warm-up window prominently in the setup wizard and onboarding documentation, with concrete guidance on what to expect during the first two weeks _(Difficulty: 1/5 · Customer Impact: 3/5)_ — [#54](https://github.com/newrelic-experimental/preflight/issues/54)
- Show partial / progressive coaching reports during warm-up — for example, "you have 3 days of data so far; here's what we can already say, and what we'll be able to say in N more days" _(Difficulty: 3/5 · Customer Impact: 4/5)_ — [#55](https://github.com/newrelic-experimental/preflight/issues/55)
- Add an MCP tool surface (e.g. `nr_observe_get_warmup_status`) that lets clients check warm-up progress at a glance _(Difficulty: 2/5 · Customer Impact: 3/5)_ — [#56](https://github.com/newrelic-experimental/preflight/issues/56)

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves), [§8 — Discovery & Access](./PRODUCT_BRIEF.md#8--discovery--access)

---

### Recommendation Engine Maturation

The launch-set product surfaces anti-pattern detection and a basic personal coaching report. Future iterations will deepen this into a true recommendation engine.

**Planned work:**

- Team-level recommendations that surface high-performing usage patterns and propagate them to other team members _(Difficulty: 3/5 · Customer Impact: 4/5)_ — [#45](https://github.com/newrelic-experimental/preflight/issues/45)
- Machine-learning-based pattern detection to surface anti-patterns and optimisation opportunities that aren't expressible in rule-based detectors _(Difficulty: 5/5 · Customer Impact: 3/5)_ — [#46](https://github.com/newrelic-experimental/preflight/issues/46)

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape) (closing note), [§7 — Mindset Shift & Risks](./PRODUCT_BRIEF.md#7--mindset-shift--risks) (mindset shift caveat), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope)

---

### Team Intelligence

Individual-level observability is the foundation; team-level pattern recognition is the multiplier. Future work surfaces shared patterns and enables teams to learn from their own best practices.

**Planned work:**

- **Team-level CLAUDE.md recommendations** — when multiple developers on the same team share the same anti-patterns or re-read the same files in a shared codebase, generate recommendations that target the shared CLAUDE.md rather than individual configs. Team-level signal → team-level fix. _(Difficulty: 3/5 · Customer Impact: 4/5)_ — [#51](https://github.com/newrelic-experimental/preflight/issues/51)
- **Developer onboarding telemetry** — detect when someone is new to a codebase (high exploration ratio, Read-without-Edit, low efficiency score) versus operating in familiar territory. Track and compare ramp-up speed across developers and against historical baselines, to measure onboarding effectiveness and identify where better documentation or pairing would help. _(Difficulty: 2/5 · Customer Impact: 3/5)_ — [#52](https://github.com/newrelic-experimental/preflight/issues/52)
- **Cross-developer pattern propagation** — identify developers who are consistently efficient at specific task types and surface their patterns (CLAUDE.md structure, tool use sequences, prompting style) as recommendations to teammates who struggle with the same task types. Codifies the "ask your most efficient colleague" instinct at scale. _(Difficulty: 4/5 · Customer Impact: 4/5)_ — [#53](https://github.com/newrelic-experimental/preflight/issues/53)

---

### Pre-Deployment Consumption Estimation

The brief asserts in [§6 — Clear Consumption Communication](./PRODUCT_BRIEF.md#6--user-must-haves) and [§7 — Consumption Surprises](./PRODUCT_BRIEF.md#7--mindset-shift--risks) that the setup wizard _should_ help a customer estimate the ingest volume — and the resulting New Relic bill — that their chosen instrumentation will produce, before they deploy it. That capability does not exist today. Without it, customers face a real risk of unexpected NR consumption costs after rolling out broadly.

**Planned work:**

- Build a pre-deployment estimator into the setup wizard / CLI that takes the customer's intended instrumentation scope (which AI clients, how many developers, expected sessions per developer per day) and produces a projected daily / monthly ingest volume _(Difficulty: 4/5 · Customer Impact: 4/5)_ — [#60](https://github.com/newrelic-experimental/preflight/issues/60)
- Translate that ingest projection into an estimated New Relic platform cost using the customer's plan (or a per-account-tier default) _(Difficulty: 3/5 · Customer Impact: 4/5)_ — [#61](https://github.com/newrelic-experimental/preflight/issues/61)
- Surface the estimate at every opt-in step, so a customer toggling on "instrument the entire platform team" sees the bill impact before committing _(Difficulty: 2/5 · Customer Impact: 3/5)_ — [#62](https://github.com/newrelic-experimental/preflight/issues/62)
- Provide a post-deployment reconciliation: the wizard's first-week summary should compare actual ingest to the projection so the model can be improved _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#63](https://github.com/newrelic-experimental/preflight/issues/63)

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves) (Clear Consumption Communication), [§7 — Mindset Shift & Risks](./PRODUCT_BRIEF.md#7--mindset-shift--risks) (Consumption Surprises)

---

### IDE-Embedded Surfaces

Launch coverage surfaces telemetry through MCP tools, dashboards, alerts, and (eventually) the New Relic UI. A natural next step is in-IDE visibility so developers see their own coaching insights without leaving their editor.

**Planned work:**

- IDE extension integration (VS Code, JetBrains) to surface personal coaching, anti-pattern history, and recent session metrics directly inside the editor without leaving the IDE _(Difficulty: 4/5 · Customer Impact: 4/5)_ — [#49](https://github.com/newrelic-experimental/preflight/issues/49)
- Inline cost estimation as a developer works (predict the cost of the current session based on recent activity) _(Difficulty: 3/5 · Customer Impact: 3/5)_ — [#50](https://github.com/newrelic-experimental/preflight/issues/50)

**Brief references:** [§8 — Discovery & Access](./PRODUCT_BRIEF.md#8--discovery--access) (in-platform surfaces), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope)

---

### Enterprise Controls

The product respects existing New Relic RBAC and supports a high-security mode that disables content capture entirely. Full enterprise-tier readiness still requires additional integration work.

**Planned work:**

- RBAC integration for fine-grained access control over AI Observatory data (per-team data isolation, per-developer view restrictions) _(Difficulty: 5/5 · Customer Impact: 4/5)_ — [#64](https://github.com/newrelic-experimental/preflight/issues/64)
- Per-team data isolation guarantees for multi-tenant customer accounts _(Difficulty: 4/5 · Customer Impact: 4/5)_ — [#64](https://github.com/newrelic-experimental/preflight/issues/64)
- Configurable redaction policies beyond the current `DEFAULT_REDACTION_PATTERNS` set _(Difficulty: 2/5 · Customer Impact: 3/5)_ — [#65](https://github.com/newrelic-experimental/preflight/issues/65)

**Brief references:** [§6 — User Must-Haves](./PRODUCT_BRIEF.md#6--user-must-haves) (Standard Enterprise Controls), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #8)

---

### Platform Adapter Set Expansion

Launch coverage targets nine AI coding clients. The AI coding tooling space is fragmenting rapidly, so adapter coverage is an ongoing investment.

**Planned work:**

- Ongoing adapter cadence after GA to keep coverage gap below ~6 months for popular new AI tools _(Difficulty: 2/5 · Customer Impact: 2/5)_ — [#66](https://github.com/newrelic-experimental/preflight/issues/66)
- Adapter contribution model so customers and the open-source community can submit adapters for tools we haven't covered _(Difficulty: 3/5 · Customer Impact: 2/5)_ — [#67](https://github.com/newrelic-experimental/preflight/issues/67)

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape), [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan) (GA out-of-scope), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #9), [§13 — Additional Flags](./PRODUCT_BRIEF.md#13--additional-flags) (AI tooling velocity risk)

---

### Audit and Compliance Surface Extension

Launch coverage captures sensitive file access, destructive command execution, and external network requests. Future work extends this surface to track an expanding regulatory landscape (EU AI Act, analogous regulations elsewhere).

**Planned work:**

- Expand the audit event schema to cover additional regulated activities as compliance frameworks specify them _(Difficulty: 2/5 · Customer Impact: 2/5)_ — [#68](https://github.com/newrelic-experimental/preflight/issues/68)
- Provide compliance-report templates (NRQL queries and dashboards) for common audit asks _(Difficulty: 1/5 · Customer Impact: 3/5)_ — [#69](https://github.com/newrelic-experimental/preflight/issues/69)
- Inherit and document applicable platform compliance certifications (SOC 2 Type II, ISO 27001) as they apply to the underlying New Relic platform _(Difficulty: 1/5 · Customer Impact: 3/5)_ — [#70](https://github.com/newrelic-experimental/preflight/issues/70)
- Configurable retention policies aligned with customer compliance requirements (the `retainSessionsDays` config field supports arbitrary values; expand to preset compliance-friendly defaults as needed) _(Difficulty: 1/5 · Customer Impact: 2/5)_ — [#71](https://github.com/newrelic-experimental/preflight/issues/71)

**Brief references:** [§3 — Competitive Landscape](./PRODUCT_BRIEF.md#3--competitive-landscape) (closing note), [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #7)

---

### Environmental Impact

AI model inference has a measurable energy footprint. Future work surfaces this in the Observatory without making unverifiable emissions claims.

**Planned work:**

- **Carbon intensity view** _(pending provider data)_ — once a major provider publishes an official per-token carbon intensity figure, add a session-level carbon impact view that translates token usage into CO2e with a clear citation of the underlying data. Intentionally deferred until the numbers are defensible; publishing estimates derived from unofficial figures risks undermining trust in the cost data the Observatory already surfaces. _(Difficulty: 2/5 · Customer Impact: 2/5)_ — [#72](https://github.com/newrelic-experimental/preflight/issues/72)

---

### OpenTelemetry GenAI Convention Compliance

Span attributes already follow OpenTelemetry GenAI semantic conventions for portability. Future work formalises that compliance.

**Planned work:**

- Formal certification of span attributes against OpenTelemetry GenAI semantic conventions _(Difficulty: 2/5 · Customer Impact: 2/5)_ — [#47](https://github.com/newrelic-experimental/preflight/issues/47)
- Stay current with OTel GenAI convention revisions as the spec evolves _(Difficulty: 1/5 · Customer Impact: 2/5)_ — [#48](https://github.com/newrelic-experimental/preflight/issues/48)

**Brief references:** [§11 — Milestones & Dependencies](./PRODUCT_BRIEF.md#11--milestones--dependencies) (milestone #6), [Appendix A](./PRODUCT_BRIEF.md#appendix-a--high-level-public-facing-apis)

---

## Notes

- This roadmap is not committed; items may shift or drop based on customer feedback during Customer Zero, Design-Partner Validation, and the Initial Labs Publication phases (see [§10 — Rollout Plan](./PRODUCT_BRIEF.md#10--rollout-plan)).
- Each themed area above maps to one or more issues / milestones in the GitHub repository once published; this document is the human-readable narrative version.
- The brief's [Decisions](./PRODUCT_BRIEF.md#open-questions) section captures the resolved positioning questions (free via Labs, no entitlement, Labs publication workflow, etc.) that shaped this roadmap.
