# NR AI Coding Observability — Product Brief

## Table of Contents

[Overview Questions](#overview-questions)

[Executive Summary](#executive-summary)

[1 — Target Audience & Market](#1--target-audience--market)

[2 — Business Impact](#2--business-impact)

[3 — Competitive Landscape](#3--competitive-landscape)

[4 — Elevator Pitch & TAM](#4--elevator-pitch--tam)

[5 — Monetization & Pricing](#5--monetization--pricing)

[6 — User Must-Haves](#6--user-must-haves)

[7 — Mindset Shift & Risks](#7--mindset-shift--risks)

[8 — Discovery & Access](#8--discovery--access)

[9 — Overlap & Category](#9--overlap--category)

[10 — Rollout Plan](#10--rollout-plan)

[11 — Milestones & Dependencies](#11--milestones--dependencies)

[12 — Domain & Support](#12--domain--support)

[13 — Additional Flags](#13--additional-flags)

[Open Questions](#open-questions)

[Appendix A — Public Facing APIs](#appendix-a--high-level-public-facing-apis)

---

## Overview Questions

| Product / Initiative Name | Marketing Name TBD / NR AI Coding Observability / AI Coding Insights |
| :---: | :---- |
| Product Manager & Engineering Manager | PM: TBD EM: TBD |

## Executive Summary

The software development industry is in the middle of the fastest tooling transition in its history. AI coding assistants — Claude Code, GitHub Copilot, Cursor, Windsurf, and a long tail of emerging entrants — are being adopted by engineering organisations at unprecedented speed, yet are operating almost entirely outside the existing observability stack. AI tooling vendors are starting to release usage telemetry, but coverage is uneven and rarely composes across tools. Engineering leaders today have limited visibility into how much these tools cost per session, per project, or per developer; whether their teams are using them effectively; whether security and compliance controls are being respected; or whether the productivity gains they were promised are actually materialising.

NR AI Coding Observability represents New Relic's strategic response to this emerging discipline. Building on New Relic's foundational strength as the observability platform for production systems, NR AI Coding Observability extends that same data model and query surface to the AI development workflow itself. The solution captures every tool call, model interaction, anti-pattern, and cost event from a developer's AI assistant; correlates it with the existing telemetry New Relic already collects; and surfaces it through MCP tools, dashboards, alerts, and OpenTelemetry traces.

NR AI Coding Observability fundamentally extends the New Relic value proposition into the build phase of the software lifecycle. Rather than monitoring only what runs in production, New Relic now also illuminates how that production software is being created, by whom, with which AI assistants, at what cost, and with what efficiency. This addresses an urgent customer imperative: bring AI development spending under the same observability discipline already applied to compute, storage, APM, and the rest of the stack. NR AI Coding Observability establishes a powerful new category — AI development observability — and positions New Relic as the platform of record for the AI-augmented engineering organisation.



---

## 1 — Target Audience & Market

### Target Audience and Market

NR AI Coding Observability has a three-tiered audience because adoption depends on different people for different reasons: champions who deploy and drive rollout, users who must consent to instrumentation, and beneficiaries who consume the reports without directly using the product.

**Primary — Champions and Adopters**

Engineering managers, platform and devtools team leads, and directors of engineering who deploy this and drive org-wide adoption. They own the "how is my team using AI?" question and consume the team-level views (cost-by-team, anti-pattern trends, weekly digests) most directly. Without their push, you only get scattered individual installs.

- Engineering Managers and Directors of Engineering
- Platform Engineering and DevTools team leads owning the AI assistant deployment
- Heads of Platform and Heads of Developer Productivity running developer-experience programs

**Primary — Users Generating the Telemetry**

Senior Software Engineers and Staff Engineers who install the hooks, consent to instrumentation, generate the session data, and consume the personal coaching report. They are not the buying audience, but adoption fails without their willingness to instrument.

- Senior Software Engineers and Staff Engineers using Claude Code, Cursor, Copilot, Windsurf, Zed, Continue.dev, or Amazon Q Developer
- Engineering team leads coaching their teams on effective AI usage

**Beneficiaries — Executive and Governance Stakeholders**

VPs of Engineering, FinOps, Security, and Compliance teams who consume the data through dashboards, alerts, and audit reports but do not directly use the product day-to-day. They are the primary consumers of the executive and compliance narratives the product enables.

- VPs of Engineering consuming cost-per-outcome and ROI reports for executive briefings
- FinOps and Procurement teams consuming AI spend breakdowns for budget governance
- Application Security and Compliance teams consuming the audit trail for regulatory reporting

### Customer Problems to Solve

**Opaque AI Spend**

Engineering organisations have rolled out AI coding assistants at unprecedented speed, but have almost no visibility into the resulting cost. Spend is buried in vendor invoices that arrive monthly with no breakdown by team, project, developer, model, or task type. Leaders cannot answer the most basic governance questions: "How much did the platform team spend on AI this week, and on what?"

**Unverified Productivity Claims**

The productivity narrative around AI coding tools is dominated by vendor case studies and anecdote. Engineering leaders making seven-figure platform decisions have no neutral, measurable, longitudinal data on whether AI assistants are actually accelerating their teams, and where the gains are concentrated. Without data, ROI conversations devolve into faith.

**Workflow Anti-Patterns at Scale**

AI coding assistants have introduced an entirely new class of failure modes — thrashing, repeated re-reads of the same files, stuck loops, blind edits, over-delegation to subagents — that are invisible to traditional observability and undetectable by the AI assistants themselves. These patterns silently inflate cost and degrade developer trust.

**Fragmented Tooling, Fragmented View**

Most engineering organisations are not standardised on a single AI assistant. Claude Code, Cursor, Copilot, and Windsurf coexist in the same teams. Each tool exposes its own limited usage dashboard, none of which compose with each other or with the rest of the engineering observability stack. Leaders cannot answer "how is my team using AI" without manually reconciling four vendor portals.

**Security and Compliance Blind Spots**

AI coding assistants read source code, configuration, and credentials; execute commands; and call external APIs. Most organisations have no audit trail of what the assistant accessed, what it ran, and what it transmitted. As the EU AI Act and analogous regulations come into force, this audit gap is moving from inconvenient to non-compliant.

### Validation and Confidence

**An Emerging Discipline With Real Spend Behind It**

AI coding assistant spend has moved from experimental to material in less than 24 months. Organisations now routinely report five- to seven-figure annual commitments to Claude Code, Copilot Enterprise, Cursor, and equivalent tools — frequently larger than their APM line item. Spend at this scale without observability is unsustainable, and procurement is already pushing back.

**A Greenfield Category**

The AI app-observability space (Langfuse, Helicone, LangSmith, Braintrust, Arize Phoenix) is well-populated, but those tools target developers building LLM-powered applications, not engineering organisations using AI assistants to write code. AI coding observability specifically remains an open category with no incumbent.

**New Relic's Existing Telemetry Advantage**

The customers who most need this capability — engineering organisations already running observability platforms — are New Relic's existing customers. NR AI Coding Observability does not require a new buying centre, a new procurement cycle, or a new agent. It extends the platform our customers already trust into a new dimension of their engineering operation.

### Why Now?

Three forces have converged. First, market scale: AI coding assistant adoption inside engineering organisations crossed the line from pilot to production in 2025; spend is now material and visible to finance. Second, governance pressure: FinOps, security, and compliance organisations are now actively asking for the data the AI tool vendors do not provide. Third, the open-source observability ecosystem (OpenTelemetry GenAI semantic conventions, MCP) has stabilised enough to make a vendor-neutral observability layer technically viable.

The window to define the category, set the schema, and become the platform of record is open now. It will not stay open long.


---

## 2 — Business Impact

The NR AI Coding Observability initiative establishes New Relic as the platform of record for the fastest-growing new category of engineering spend: AI-assisted software development. It opens a new revenue surface tied directly to AI tooling adoption, deepens platform stickiness with our largest customers, and protects New Relic's existing footprint against competitive observability platforms moving to claim the category first.

### What We Stand to Gain

**Establish New Relic as the System of Record for AI Development**

The strategic prize is category definition. Every engineering organisation will need an AI development observability layer within 24 months. By shipping a credible, vendor-neutral, multi-platform solution now, New Relic becomes the default answer when engineering leaders ask "how do we get our arms around our AI coding spend and effectiveness?" Once the schema, dashboards, and alert library are in place inside a customer's account, switching cost is high.

**Indirect Revenue Through Increased Platform Consumption**

NR AI Coding Observability is published as a free open-source Labs asset, so it does not generate direct licence or SKU revenue (see [Resolved: Free via New Relic Labs](#resolved-free-via-new-relic-labs-was-oq1)). Revenue accrues indirectly: customers running NR AI Coding Observability emit events, metrics, and logs that are ingested, stored, and queried through the standard New Relic platform — billed at standard ingest and compute rates. As AI coding adoption grows, the volume of that telemetry grows with it, expanding existing accounts' platform consumption.

**Deepen Platform Stickiness**

Customers who ingest AI coding telemetry into New Relic become significantly harder to displace. The data is high-cardinality, longitudinal, and joinable with their existing APM and Infra telemetry. Once an engineering leader is using NR AI Coding Observability to brief their executive team on AI ROI, displacing the underlying observability platform becomes a cross-functional decision involving engineering leadership, FinOps, and compliance — not just a tools team comparison.

**Protect Against Competitive Encroachment**

Datadog, Honeycomb, and the LLM-native observability vendors (Langfuse, Helicone, Braintrust) are all positioned to extend into this space. Each has a partial answer; none has shipped a coding-assistant-specific solution at platform scale. Shipping NR AI Coding Observability denies them the category-defining position and forces any future entrant to compete against an established New Relic offering rather than greenfield.

### Business Goals and Measurement

**Measurable AI Spend Optimisation**

The primary value our customers buy is the ability to reduce or rationalise AI coding spend without losing developer velocity. Success looks like a customer reporting that they cut their monthly AI spend by 15–30% within the first quarter of using the product, while holding developer-perceived productivity flat or improving it. We measure this through aggregated, opt-in customer cost-trend data and through case studies.

**Weekly Active Engineering Leaders**

The leading indicator that the product is delivering value is whether engineering leaders return to it weekly. We measure WAU among the primary audience (engineering managers, platform leads, FinOps), not just total developers, because this audience drives renewal and expansion. A target of >50% WAU among activated engineering-leader seats within 90 days indicates the product has become a habitual decision-making tool rather than a curiosity dashboard.

**Adoption Breadth: Tools and Providers Covered Per Account**

The product's value scales with the breadth of AI tooling under observation. We measure the average number of distinct AI assistants and SDK providers reporting telemetry per active account, with a target of ≥2 within the first quarter and ≥3 within a year. Breadth proves the multi-platform thesis and indicates the product is being adopted as the central observability layer rather than a single-tool dashboard.

**Anti-Pattern Resolution Rate**

As anti-pattern detection matures, we track the rate at which detected anti-patterns are addressed (resolved, dismissed, or fixed at the source via CLAUDE.md or rules updates) within 14 days. This metric proves the product is producing actionable signal, not noise — the single most important quality measurement for the category.

**Revenue Metrics**

Standard SaaS revenue measurement applies: ARR contribution, attach rate to existing accounts, average revenue per account on the AI Observatory line item, and net revenue retention. Specific targets are set during the launch planning phase.

**Measurement Mechanism**

Telemetry on activation, WAU, and adoption breadth is collected through standard New Relic product analytics. Spend optimisation outcomes and anti-pattern resolution rates are surfaced through opt-in customer reporting and the product's own dashboards. Dashboard locations and reporting cadence will be defined during launch planning.


---

## 3 — Competitive Landscape

AI development observability is an emerging category with several adjacent vendors but no incumbent purpose-built for AI coding assistants at the engineering-organisation level. The landscape is best understood as four overlapping camps, each with a partial answer.

### The Competitive Landscape

**LLM Application Observability Vendors** — *Langfuse, Helicone, LangSmith, Braintrust, Arize Phoenix*

These tools are designed for developers building LLM-powered applications — they instrument the application's calls into the model and surface latency, cost, and quality metrics for that application's traffic. They do not observe AI coding assistants themselves, do not capture developer-workflow telemetry (tool calls, anti-patterns, session structure), and have no concept of "engineering organisation" as a unit of analysis. Customers using these tools to try to govern AI coding spend report that the data shape is wrong: it is per-request, not per-developer-session, and it covers their applications, not their engineers.

**AI Coding Tool Vendors' Native Dashboards** — *Anthropic Claude Console, GitHub Copilot Metrics API, Cursor Admin, Windsurf Admin*

Each AI coding vendor offers a usage dashboard for their own tool. These are limited by design — each shows only its own data, exposes only the metrics the vendor chooses, and does not federate with the rest of an organisation's observability stack. They serve operational reporting (seat counts, basic usage) but cannot answer cross-tool questions, cannot correlate with APM or infrastructure data, and cannot detect workflow anti-patterns. Vendor lock-in is implicit — a customer who depends on Copilot's dashboard cannot ask the same question of their Cursor or Claude Code users.

**Broad Observability Platforms** — *Datadog, Honeycomb, Splunk Observability*

These platforms have begun adding LLM observability features (Datadog LLM Observability, Honeycomb's recent OpenLLMetry integration), focused primarily on the LLM-application use case described above. None has shipped a coding-assistant-specific solution. Their data models are not yet adapted to the workflow, anti-pattern, and developer-coaching concepts that define this category. They have the platform reach to enter this space, but have not yet committed to it.

**AI Developer Productivity Analytics** — *Faros AI, LinearB, DX, Jellyfish*

These tools focus on engineering productivity measurement broadly — DORA metrics, cycle time, sprint analytics — and have begun adding AI-specific surfaces. Their data sources are typically Git, ticketing systems, and CI; they do not observe the AI assistant itself. Their value proposition addresses the "is the team productive?" question at the level of shipped code, not the "is AI being used effectively?" question at the level of the developer's workflow.

### How Customers Solve These Problems Today

Without a dedicated solution, engineering organisations are stuck reconciling four to six disconnected sources by hand.

**Spend Tracking** — The FinOps team exports monthly invoices from Anthropic, GitHub, Cursor, and any other AI vendors, hand-keys them into a spreadsheet, and divides by seat counts to produce an extremely rough per-developer cost. Breakdowns by team, project, or task type are not possible — the data is not in the invoices.

**Productivity Assessment** — Engineering leadership relies on developer survey data ("do you feel more productive?") combined with vendor case studies. Some organisations attempt to instrument their own usage tracking using the AI vendors' APIs, but the data is per-tool and incomparable across tools.

**Anti-Pattern Detection** — Anti-patterns are detected, when they are detected at all, through individual developer self-awareness or through team leads reading shared session transcripts. There is no programmatic detection at organisation scale.

**Compliance and Audit** — Audit logs, when available from the AI vendor, are reviewed manually or not at all. Most organisations have no audit record of what their AI assistants accessed.

### How We Are Different

NR AI Coding Observability is strategically different because it is the first solution purpose-built for the engineering organisation as the unit of analysis, layered on a general-purpose observability platform that customers already trust.

**Multi-Platform, Multi-Provider Coverage Out of the Box**

The product ships with adapters for eight AI coding clients (Claude Code, Cursor, Windsurf, Copilot, Zed, Continue.dev, Amazon Q, generic MCP). Customers do not have to choose a single AI tool to be observable — the data model normalises across all of them and produces a single cross-tool view. No competitor offers this breadth.

**Workflow-Aware, Not Just Request-Aware**

Where LLM application observability tools capture individual model requests, NR AI Coding Observability captures the developer's session structure: tool calls grouped into tasks, file-access patterns, anti-patterns, CLAUDE.md change impact, and personal coaching trends. This is the data shape engineering leaders actually need to govern AI usage; no other vendor produces it.

**Joins Natively With Existing New Relic Telemetry**

Because NR AI Coding Observability is a layer on top of New Relic, the AI coding telemetry is queryable in NRQL alongside APM, Infra, Logs, and Browser data. Engineering leaders can correlate AI coding activity with deployment events, production incidents, and customer-facing performance — the kind of cross-domain question that no point solution can answer.

**Built for the Engineering Organisation, Not the Application**

The data model is keyed on developer, team, project, and organisation — the dimensions engineering leaders actually use to make decisions. Cost is sliced by team and project; anti-patterns are tracked per developer; weekly digests are sent to Slack. The product is shaped like the customer's organisational chart, not like a request log.

**Vendor-Neutral by Design**

Adopting NR AI Coding Observability does not require choosing or excluding any AI tool vendor. The product treats Claude Code, Copilot, and Cursor as peers and lets the customer's tooling decisions drive the data. This neutrality is critical because most engineering organisations explicitly want to retain optionality across AI vendors.

**Compliance and Audit as a First-Class Concern**

The product captures a structured audit trail of sensitive file access, destructive command execution, and external network requests by AI assistants — alongside redaction primitives for sensitive content. As the EU AI Act and analogous regulations come into force, this audit surface is the basis for AI usage compliance reporting that no AI vendor's native dashboard provides.

*Note: The first iteration focuses on the core observability surface — telemetry capture, dashboards, alerts, anti-pattern detection, and the multi-tool data model. Future iterations will deepen the recommendation engine, expand the platform adapter set, and extend the audit and compliance surface. See [ROADMAP.md](./ROADMAP.md) for the full list of post-launch roadmap themes.*

---

## 4 — Elevator Pitch & TAM

New Relic's NR AI Coding Observability is the observability platform for AI-assisted software development. It captures every AI coding tool call, model interaction, anti-pattern, and cost event from your developers' AI assistants — across Claude Code, Copilot, Cursor, Windsurf, and every other major coding tool — and turns that data into the dashboards, alerts, and audit trails your engineering, FinOps, and compliance teams need to govern AI spend and prove AI ROI.

NR AI Coding Observability directly addresses the urgent customer need to bring AI development under the same observability discipline already applied to production systems. It positions New Relic as the platform of record for the AI-augmented engineering organisation, capturing a new and rapidly growing observability spend category that did not exist 24 months ago.

Market opportunity is sized by the global AI coding assistant market (TBD: insert sized estimate from market analysis), of which we estimate 5–10% will flow to associated observability and governance tooling — the same ratio observability historically captures from underlying infrastructure spend.


---

## 5 — Monetization & Pricing

NR AI Coding Observability will be released as a free open-source asset through New Relic Labs (see [Resolved: Free via New Relic Labs](#resolved-free-via-new-relic-labs-was-oq1)). The product itself has no SKU, no licence fee, no entitlement, and no paywall.

**Distribution and Licensing**

The asset is published to the `newrelic` or `newrelic-experimental` GitHub organisation as open source. Customers install it themselves and consume it at no licence cost. New Relic does not charge separately for the analytical surface (dashboards, alert library, anti-pattern detectors, recommendation engine, audit trail).

**Indirect Monetisation Through Platform Consumption**

Revenue is generated indirectly through standard New Relic platform consumption: customers running NR AI Coding Observability emit events, metrics, and logs that flow through the platform's existing billing model (data ingest, query compute, dashboard rendering, alert evaluation). The volume of that consumption scales with the customer's AI-coding adoption.

**Customer Control of Consumption**

Customers retain granular control over their consumption: they choose which AI tools to instrument, which developers to onboard, which dashboards to deploy, and which alerts to enable. Aggressive instrumentation increases data volume and therefore platform spend; minimal instrumentation produces minimal incremental cost. The opt-in surface is per AI client and per developer, allowing engineering leaders to scale instrumentation deliberately.

**Support Model**

Labs assets are supported through Labs' own channels — GitHub issues, the `#help-labs-dev` Slack channel, and Labs Work Items — rather than standard New Relic GTS support. Maintenance commitment is determined by the asset's Labs category (Community, Public Catalog, or Experimental); see the resolved decision linked above for details.


---

## 6 — User Must-Haves

From the user's perspective, NR AI Coding Observability must transform AI coding governance from an after-the-fact invoice review exercise into a continuous, opt-in, multi-stakeholder workflow. It must serve four user roles simultaneously — engineering leaders, platform owners, finance and compliance reviewers, and individual senior developers — each of whom needs a distinct surface drawing on the same underlying telemetry.

### Discovery and Onboarding

**Open Source, Self-Install**

Customers discover NR AI Coding Observability in the New Relic Labs catalog and on GitHub. There is no paywall and no trial — the asset can be installed by any New Relic customer at any time. The core onboarding moment is the customer connecting their first AI assistant to New Relic — a process that must take under ten minutes from initial install to first telemetry visible in a dashboard.

**Per-Tool, Per-Developer Opt-In**

Onboarding is centred on user control. The customer enables the capability at the account level, then chooses which AI clients to instrument (Claude Code, Cursor, Copilot, Windsurf, Zed, Continue.dev, Amazon Q, generic MCP) and which developers to onboard. Adoption can begin with a single team or a single tool and expand from there.

**Setup Wizard and CLI**

The product includes an interactive setup wizard that walks through account configuration, hook installation, and first dashboard deployment in a single session. A backfill script (`scripts/backfill-sessions.ts`) is available for state-recovery scenarios — customers who already had NR AI Coding Observability telemetry in NR but whose local session files are missing can reconstruct that state from the existing events. Net-new customers do not have anything to backfill and will accumulate session data over a roughly two-week warm-up before personal coaching reports return useful output; until then, `nr_observe_get_personal_insights` returns an `insufficient_data` status with a clear message.

**Clear Consumption Communication**

Although NR AI Coding Observability itself is free, customer cost flows through standard New Relic platform consumption (data ingest, query compute). Documentation and the setup wizard should help a customer estimate the consumption impact of their instrumentation before deploying it — answering "if I instrument my entire platform team, how much additional ingest does that produce, and what does that mean for my New Relic bill?" before committing.

### Core User Experience

**Surface AI Spend Across the Organisation**

The product must surface total AI coding spend, broken down by developer, team, project, AI tool, model, and task type, in a single dashboard that an engineering leader can read in under five minutes. Cost trends, forecasts, and budget burn-down must be available out of the box.

**Detect Workflow Anti-Patterns Automatically**

The product must detect and surface anti-patterns specific to AI coding — thrashing, repeated re-reads of the same files, stuck loops, blind editing, over-delegation to subagents — with high enough confidence to be actionable. Anti-pattern signal quality is the single most important quality bar; noisy detection destroys trust faster than missed detection.

**Per-Developer Coaching Without Surveillance**

The product must offer individual developers a personal coaching surface — efficiency trends, anti-pattern history, model usage breakdown, weekly comparison to personal baseline — that helps them improve their own workflow. This surface must be designed to coach, not surveil. The same data must not be exposed to managers in a way that creates a performance-management surveillance dynamic; aggregated team-level views must summarise patterns without identifying individuals as outliers.

**Compliance-Grade Audit Trail**

The product must capture an audit trail of sensitive file access, destructive command execution, and external network requests by AI assistants, with redaction primitives applied before any telemetry leaves the developer's machine. Audit records must be queryable, exportable, and retainable per the customer's compliance policy, with defaults set to industry norms (90/180/365-day retention options).

### Workflow Integration

**Cross-Session and Longitudinal Analysis**

The product must group telemetry into developer sessions, tasks, and weeks, enabling comparison across time horizons. Engineering leaders must be able to ask "how did our AI usage change after we updated our internal CLAUDE.md guidelines" and receive a quantitative answer.

**Alert Library and Cost Budgets**

A pre-built library of NRQL alert conditions covers the most common governance concerns: cost spikes, low efficiency scores, stuck-loop frequency, anti-pattern thresholds, and budget overruns. Customers can deploy the full set with one command and tune thresholds from there. Personal alert thresholds are also supported per developer.

**Slack Digest and Webhook Integration**

A weekly digest summarising AI spend, top anti-patterns, and team-level efficiency trends posts automatically to a configured Slack channel or HTTP webhook. This drives habitual engagement among engineering leaders without requiring them to log in to view a dashboard.

**Standard Enterprise Controls**

The product respects existing New Relic RBAC, supports per-team data isolation, retains all data inside the customer's New Relic account, and offers a high-security mode that disables content capture entirely for organisations with maximum data-handling restrictions.


---

## 7 — Mindset Shift & Risks

### Mindset Shifts

**From "AI Spend Is a Black Box" to "AI Spend Is Governed Like Any Other Cloud Resource"**

*Current mindset:* We adopted Claude Code and Cursor because our developers wanted them. Our monthly AI invoices are large and growing, and I can't tell my CFO who is generating that cost or whether we are getting our money's worth.

*New mindset:* I have a weekly view of AI spend per team, project, and developer, with budget thresholds, alerts, and forecasts. I treat AI development cost the same way I treat compute — instrumented, optimised, and accountable.

This is the most important shift the product enables. AI tooling moves from being a procurement and tools-team problem to being a fully governed cost centre with the same operational discipline applied to any other infrastructure line item. Cost dashboards land in the same New Relic UI engineering leaders already use for production observability. Budget alerts fire into the same Slack channels their existing alerts fire into. The discipline transfers because the surface is identical.

---

**From "I Hope AI Is Helping" to "I Can Prove AI Is Helping"**

*Current mindset:* I bought AI coding tools because the productivity claims sounded compelling, but I have no neutral data on whether my teams are actually shipping faster or making fewer mistakes.

*New mindset:* I have measurable efficiency scores, task completion rates, anti-pattern frequencies, and cost-per-task numbers per team, tracked weekly. I can prove which AI tools and which usage patterns are working, and which are not.

This shift is what unlocks the executive narrative. ROI moves from being a faith-based claim to being a tracked metric, which fundamentally changes how engineering leaders make AI tooling decisions and how they justify them upward. Pre-built dashboards target the executive narrative directly: cost-per-outcome reports, weekly trend lines, before-and-after comparisons triggered by configuration changes.

---

**From "AI Tool Adoption Is Risky and Unmonitored" to "AI Tool Adoption Is Auditable and Compliant"**

*Current mindset:* I know my developers are using AI assistants on our codebase, but I cannot tell you what files those assistants accessed, what they wrote, or what they transmitted to external services. If our auditors asked, I would not have an answer.

*New mindset:* Every sensitive file access, destructive command, and external network request from an AI assistant is captured in a structured audit trail, redacted, retained per our compliance policy, and queryable on demand.

The audit surface is built into the product from day one rather than added later. Compliance and security teams are surfaced as primary users of the dashboards, not as afterthoughts.

---

**From "Each Developer Improves on Their Own" to "AI Workflow Is a Coachable Discipline"**

*Current mindset:* Some of my engineers are very effective with AI; others are not. I have no way to identify what the effective ones are doing differently or to teach the rest.

*New mindset:* Each developer has a personal coaching surface showing their efficiency trends, anti-pattern history, and concrete optimisation recommendations. Team leads can identify high-performing patterns and propagate them. *(This will deepen significantly in future iterations — see [Recommendation Engine Maturation in ROADMAP.md](./ROADMAP.md#recommendation-engine-maturation).)*

The personal coaching report is designed to read like advice from a teammate rather than a performance review. Aggregations roll up to patterns, not to individual rankings.

### Potential Customer Disappointments

**Noise in Anti-Pattern Detection**

NR AI Coding Observability promises high-confidence detection of AI coding anti-patterns. If our analysers produce false positives — flagging legitimate exploratory sessions as "thrashing" or treating intentional re-reads as inefficiency — engineering leaders will lose trust quickly and developers will resent being measured against a noisy metric. The bar for analyser quality is the bar for the product overall.

**Surveillance Concerns**

The personal coaching report and per-developer cost breakdowns are powerful, but if they are perceived as a surveillance tool by individual contributors, the product will face cultural pushback that no engineering leader wants to fight. The product must be visibly designed to coach individuals and report patterns to managers — not to identify individual outliers to managers. If we get this dynamic wrong, adoption stalls inside the very teams we are trying to instrument.

**Consumption Surprises**

Although NR AI Coding Observability itself is free, the telemetry it generates flows through standard New Relic ingest and compute billing. Customers who instrument aggressively without first understanding their AI usage scale may see unexpected New Relic bills. Documentation and the setup wizard must communicate the projected ingest volume clearly; if customers feel ambushed by their first invoice, they will turn the product off rather than tune it.

**Coverage Gaps for a Specific Tool**

Customers using a specific AI assistant we have not yet adapted (the AI coding tooling space is fragmenting rapidly) will be disappointed if the product cannot observe their primary tool. We must communicate the supported-tool list clearly upfront and ship a credible adapter cadence to demonstrate ongoing investment in coverage breadth. The generic MCP adapter mitigates this for any MCP-speaking client, but is not a complete substitute for purpose-built adapters.


---

## 8 — Discovery & Access

Initial launch is targeted for June 9, 2026, immediately preceding Datadog DASH.

### Product Discovery

**In-Platform Surfaces**

How the product is discoverable inside New Relic depends on the Labs category determination (see [Resolved: UI surface depends on Labs category](#resolved-ui-surface-depends-on-labs-category-was-oq2)). If published as a **Public Catalog** asset, it will be surfaced under *Integrations & Agents → Apps & Visualizations*. If published as a **Community** or **Experimental** asset, the in-platform surface consists entirely of the deployed dashboards, alerts, and the MCP tool catalog — discovery happens through the GitHub README and Labs catalog rather than navigation entries. IDE-embedded surfaces via CodeStream are a future roadmap item ([ROADMAP.md](./ROADMAP.md#ide-embedded-surfaces)).

**External Channels**

The product will be promoted through the New Relic developer-relations channels (blog, conference talks, demo videos, partner announcements with AI tooling vendors), through an open-source community presence around the MCP server, and through targeted outreach to engineering-leadership audiences (CTO summits, FinOps community events, platform engineering conferences).

**Onboarding Path**

Customers begin with the interactive setup wizard, which configures the New Relic account binding, installs the AI client hooks, and deploys the team and personal dashboards in a single guided session. Customers migrating from a prior NR AI Coding Observability installation can run a backfill script to recover missing local session state from existing NR telemetry. Net-new customers accumulate session data over a roughly two-week warm-up before personal coaching reports return useful output (the `nr_observe_get_personal_insights` MCP tool returns an `insufficient_data` status until enough history exists).

### Access Model

**No Entitlement Required**

Because NR AI Coding Observability is a free open-source Labs asset (see [Resolved: Free via New Relic Labs](#resolved-free-via-new-relic-labs-was-oq1)), no entitlement, paywall, or trial gate stands between the customer and the product. Any New Relic customer can install it at any time.

**Per-Developer and Per-Tool Activation**

Within a customer account, individual developers and individual AI tools must be opted in explicitly during setup. This protects against runaway data ingest and against unintentional capture of AI tooling that the customer does not want instrumented.


---

## 9 — Overlap & Category

NR AI Coding Observability establishes a new product category — AI development observability — distinct from any existing New Relic capability. There is meaningful adjacency to several existing surfaces, but no overlap that would create cannibalisation risk.

### Adjacencies Worth Calling Out

**New Relic AI / GenAI Application Observability**

New Relic's existing AI application observability capabilities focus on customer-built LLM applications running in production — instrumented model calls, prompt observability, and inference-cost reporting at the application layer. NR AI Coding Observability operates at a different stage of the lifecycle: it observes the developer's AI assistant during code authoring, not the application's AI calls during runtime. The two are complementary; some customers will deploy both.

**Logs and Custom Events**

The MCP server emits New Relic custom events and metrics. There is technically nothing preventing a customer from approximating a fraction of this capability by instrumenting their AI assistant manually and shipping events to Logs or the Events API. The difference is that NR AI Coding Observability ships pre-built event schemas, dashboards, alert conditions, anti-pattern detectors, OpenTelemetry GenAI semantic convention mappings, and the analytical surface — none of which a customer assembling raw logging would receive.

**Errors Inbox**

No overlap. Errors Inbox surfaces production errors in deployed applications. NR AI Coding Observability surfaces workflow patterns in AI-assisted development. Different audience, different data, different time horizon.

### Net Effect on Existing Products

NR AI Coding Observability does not replace, deprecate, or shrink the scope of any existing New Relic product. It opens a new buying centre — engineering leaders concerned with AI tooling governance, FinOps teams concerned with AI spend, compliance teams concerned with AI audit — that has not historically been the primary buyer for any New Relic capability. Existing customers who already have APM, Logs, or Infra in place will see NR AI Coding Observability as an additive capability, not as a substitute.

### Category Positioning

A new category needs to be established. Internal naming will treat NR AI Coding Observability as a sibling capability to the GenAI Application Observability product — both fall under the broader AI Observability area — but with explicit positioning as the development-time complement to GenAI Application Observability's runtime focus. (Final category and product-area placement TBD during launch planning.)


---

## 10 — Rollout Plan

NR AI Coding Observability follows the New Relic Labs publication workflow rather than the standard CZ → LP → PP → GA progression (see [Resolved: Labs publication workflow](#resolved-labs-publication-workflow-not-cz--lp--pp--ga-was-oq5)).

### Customer Zero (Internal Validation)

**In-Scope:** New Relic engineering organisation deploys NR AI Coding Observability against its own AI tooling usage. Validates the multi-platform adapter set, the dashboard surface, the alert library, and the personal coaching report against real production engineers. Generates the testimonial data and cost-optimisation case studies that accompany the public Labs publication.

**Out-of-Scope:** External customer onboarding, marketplace listings.

### Design-Partner Validation

**In-Scope:** A small set of design-partner customers (5–10 accounts) onboarded with hands-on guidance from product and engineering ahead of broad publication. Customers cover the primary AI assistants (Claude Code, Cursor, Copilot, Windsurf) at minimum. Feedback drives anti-pattern signal quality, dashboard usability, and onboarding documentation.

**Out-of-Scope:** Formal SLAs; broad public discoverability.

### Initial Labs Publication (June 9, 2026)

**In-Scope:** Asset is published to the `newrelic` or `newrelic-experimental` GitHub organisation in its determined Labs category (see [§11 milestone #4](#11--milestones--dependencies)). Open self-install for any New Relic customer via the GitHub README and the Labs catalog. Full dashboard library, full alert library, full audit-trail surface, full anti-pattern detector set, Slack digest delivery, and the eight launch-set AI client adapters all available. Support via GitHub issues, Labs Work Items, and `#help-labs-dev` Slack.

**Out-of-Scope:** Standard New Relic GTS support (only available to Community+ assets after promotion); IDE-embedded surfaces ([roadmap](./ROADMAP.md#ide-embedded-surfaces)).

### Post-Publication Promotion (Conditional)

**In-Scope:** Based on adoption signal and customer demand, the asset may be promoted between Labs categories — Experimental → Community, or Community → Community+. Community+ promotion qualifies the asset for standard GTS support (Pathpoint precedent). Adapter set expansion delivers at least two additional AI client adapters in this phase ([roadmap](./ROADMAP.md#platform-adapter-set-expansion)).

**Out-of-Scope:** Production-grade SKU, contracts, and per-product SLAs — these don't apply to Labs assets, regardless of promotion. Customers continue to consume at standard New Relic platform rates.

---

## 11 — Milestones & Dependencies

*Add or delete rows as needed. Grid is helpful way to visualize the milestones you envision*

|  | Milestone / Dependency Description | Owner | Team | Priority *(H, M, L)* |
| :---: | :---: | :---: | :---: | :---: |
| **1** | Customer Zero deployment against New Relic's own engineering organisation; capture cost-optimisation case study | TBD | TBD | H |
| **2** | Limited Preview onboarding of 5–10 design-partner accounts covering all four major AI coding assistants | TBD | TBD | H |
| **3** | Anti-pattern signal-quality validation: minimum 80% precision target on flagged anti-patterns, validated against design-partner feedback | TBD | TBD | H |
| **4** | Labs asset category determination (Community, Public Catalog, or Experimental) and publication path | TBD | TBD | H |
| **5** | Initial Labs publication on June 9, 2026 with full self-service activation and Slack digest | TBD | TBD | H |
| **6** | OpenTelemetry GenAI semantic convention compliance certification for portability | TBD | TBD | M |
| **7** | Documentation of inherited New Relic platform compliance certifications (SOC 2 Type II, ISO 27001) as they apply to telemetry routed through the platform | TBD | TBD | M |
| **8** | RBAC integration to support per-team data isolation for enterprise customers | TBD | TBD | H |
| **9** | Adapter set expansion: at least two additional AI client adapters post-publication based on customer demand signal | TBD | TBD | M |
| **10** | Conditional promotion to Community+ status if adoption justifies elevated GTS support (Pathpoint precedent) | TBD | TBD | L |

---

## 12 — Domain & Support

NR AI Coding Observability aligns with the AI domain and is best understood as the development-time complement to New Relic's existing GenAI Application Observability capability. Where GenAI Application Observability instruments customer-built LLM applications running in production, NR AI Coding Observability instruments the AI assistants developers use to write code. The two surfaces share an underlying philosophy and a shared OpenTelemetry GenAI semantic convention foundation, but address different audiences and different lifecycle stages.

Support skillset spans AI/observability (the primary specialisation), Developer Experience (the audience), and FinOps and Compliance (the secondary stakeholder set). Support staff will need fluency in the AI coding assistant landscape and the MCP protocol in addition to standard New Relic platform support skills.

This product is not tied to any EOL or replacement. It opens a new category and does not deprecate any existing capability.


---

## 13 — Additional Flags

Three points worth flagging upfront.

**AI Tooling Velocity Risk**

The AI coding assistant landscape is moving faster than any prior tooling category. New AI clients ship weekly; existing clients change their data shape unpredictably. The product's adapter architecture is built to absorb this velocity, but our roadmap and engineering capacity must be sized to keep pace. A six-month adapter coverage gap against a popular new AI tool would meaningfully damage the product's credibility.

**Privacy and Surveillance Are the Cultural Risks, Not the Technical Risks**

Technically, the product captures redacted, opt-in telemetry through standard New Relic data-handling controls. Culturally, the data is intimate — it reveals what code each developer is reading, writing, and asking the AI about. The product positioning, the dashboard design choices, and the personal-versus-aggregate data-exposure rules must be deliberate and visibly engineered to coach individuals and report patterns to managers. Marketing and product copy must reinforce this stance consistently.

**The Open-Source Foundation Is a Strategic Asset**

The MCP server and OpenTelemetry semantic convention mappings can be released as open-source artefacts, with the analytical and intelligence surface — dashboards, alert library, anti-pattern detection, recommendation engine, audit trail, cross-session analytics — retained as the proprietary, monetised product. This split protects the commercial product while building developer-community trust around the open instrumentation layer, accelerating organic adoption.


---

## Open Questions

All five original open questions have now been resolved — four through researching New Relic Labs (the launch vehicle), and the fifth (OQ4) through auditing `scripts/backfill-sessions.ts`. Resolved items document the decision and link to the affected sections.

### Resolved: Free via New Relic Labs (was OQ1)

NR AI Coding Observability will be released as a free open-source asset through New Relic Labs. Affected sections of this brief — [§2 — Business Impact](#2--business-impact), [§5 — Monetization & Pricing](#5--monetization--pricing), [§6 — User Must-Haves](#6--user-must-haves), [§7 — Mindset Shift & Risks](#7--mindset-shift--risks), and [§8 — Discovery & Access](#8--discovery--access) — have been updated to reflect this model.

**Concrete implications:**

- **No product-level price.** No SKU, no licence fee, no premium add-on, no paywall, no entitlement, no free trial. The product itself is published to GitHub.
- **Distribution.** Released to the `newrelic` (Community / Public Catalog) or `newrelic-experimental` GitHub organisation, depending on which Labs category the asset lands in.
- **Customer cost is indirect.** Customers still pay for the underlying New Relic platform consumption — telemetry ingest, query compute, dashboard / alert compute — at standard NR rates. The product is "free" in the sense that there is no product-level meter or licence, not in the sense that ingesting telemetry is free.
- **Support model.** Labs assets do not use standard New Relic GTS support. Customers self-serve via GitHub issues, request enhancements via Labs Work Items, or ask in `#help-labs-dev` Slack. Only Community+ assets (Pathpoint is the precedent) qualify for standard GTS support.
- **Maintenance commitment** depends on the asset category:
    - **Community** — actively maintained: critical / high security vulnerabilities, platform deprecations, and breaking bugs are patched proactively; feature enhancements accepted into the backlog.
    - **Public Catalog** — same as Community, plus surfaced inside the New Relic UI under *Integrations & Agents → Apps & Visualizations*.
    - **Experimental** — passively maintained: best-effort updates, prioritised against the Labs queue.

### Resolved: UI surface depends on Labs category (was OQ2)

Whether NR AI Coding Observability has a dedicated in-platform UI is determined by which Labs category the asset lands in:

- **Public Catalog** assets are surfaced inside the New Relic UI under *Integrations & Agents → Apps & Visualizations* — these can include custom UIs built on the Programmability platform (Pathpoint is the precedent).
- **Community** and **Experimental** assets are GitHub-distributed code with no in-platform UI; users consume the analytical surface entirely through pre-built dashboards, alerts, NRQL queries, and the MCP tool surface.

The current product surface is dashboards + alerts + MCP tools + NRQL — no custom UI exists today. Whether to build one before publication reduces to milestone #4 ([§11 — Milestones & Dependencies](#11--milestones--dependencies)) — Labs asset category determination. The brief's §6 and §8 sections have been updated to describe a "data + dashboards + MCP tools" surface rather than assuming a navigable UI.

### Resolved: Config-based activation, no entitlement (was OQ3)

The original brief assumed an account-level entitlement, an activation UI showing projected billing, and per-developer / per-AI-tool opt-in gated by that entitlement. Labs assets work differently:

- **No entitlement** — Labs assets don't use entitlements; any New Relic customer can install the asset from GitHub at any time. (Resolved in §8.)
- **No activation UI** — Labs assets typically use config files and setup scripts, not in-platform UIs. The product's `~/.nr-ai-observe/config.json` plus the `nr-ai-observe install` / `nr-ai-observe setup` CLIs serve this role. (§6 has been reframed accordingly.)
- **Per-developer / per-tool activation already exists at the config level** — the `developer` field is normalised per-machine; AI client hooks are installed per-client; opt-in scope is per-tool by virtue of which adapters the customer enables.

Net: the activation gaps in the original brief disappear once you reframe activation as "configure and install" rather than "click through an entitlement UI." The brief's §6 and §8 sections have been updated.

### Resolved: Backfill is state recovery, not new-user onboarding (was OQ4)

After auditing `scripts/backfill-sessions.ts`, the script's actual purpose is state recovery for users with existing NR AI Coding Observability telemetry, not seeding new users with synthetic data:

- The script queries New Relic for events with `developer = '<name>'` and reconstructs local session summaries from `AiToolCall`, `AiCodingTask`, `AiAntiPattern`, and `Metric` events already present in NR.
- **For existing users** whose local state is missing (for example, users who were running the MCP server before personal coaching was added): the script recovers their session history correctly.
- **For truly net-new customers** with no prior NR AI Coding Observability telemetry: the script exits gracefully with `"No sessions found in New Relic for this developer and time range."` — there is no synthetic seeding because there is nothing to recover.

The brief's original framing — that the backfill provides useful day-one coaching for new customers — was misleading. New customers genuinely need to accumulate roughly two weeks of session data before personal coaching reports return useful output. This is already handled gracefully by `nr_observe_get_personal_insights`, which returns an `insufficient_data` status with a message until enough history exists.

§6 and §8 have been updated to reframe the backfill's purpose (state recovery, not cold-start onboarding) and to acknowledge the warm-up period for net-new customers. The corresponding [Backfill for Net-New Users](./ROADMAP.md#backfill-for-net-new-users) roadmap theme has been reframed to focus on improving the cold-start UX (clearer documentation, partial coaching during warm-up) rather than re-architecting the backfill itself.

### Resolved: Labs publication workflow, not CZ → LP → PP → GA (was OQ5)

New Relic Labs does not use the standard New Relic core-product cadence (Customer Zero → Limited Preview → Public Preview → General Availability). Labs releases work as follows:

- **Internal development.** Labs builds the asset to spec, with optional Customer Zero dogfooding inside the New Relic engineering organisation.
- **Initial publication.** The asset is published to the `newrelic` or `newrelic-experimental` GitHub organisation. Publication category (Community / Public Catalog / Experimental) is determined at this point and dictates ongoing maintenance commitment.
- **Promotion path.** Assets can be promoted later — for example, an Experimental asset becoming Community, or a Community asset earning Community+ status (the Pathpoint precedent), which qualifies it for standard GTS support.

The June 9, 2026 launch date corresponds to **initial publication**, not to a Public Preview or GA milestone. §10 has been rewritten to reflect the Labs publication workflow; §11 milestones have been updated to remove launch artefacts (production pricing, contracts, SLAs) that don't apply to Labs assets.


---

## Appendix A — High Level Public Facing APIs

* *MCP tool surface — 27 tools currently exposed to AI coding clients; full specification at `docs/COMMANDS_TABLE.md` in the open-source repository.*
* *NRQL event schema — public event types (`AiToolCall`, `AiCodingTask`, `AiAntiPattern`, `AiMcpToolCall`, `AiProxyRequest`, `AiAuditEvent`, `AiBudgetWarning`, `AiCostGrowthAlert`, `AiCostForecastAlert`, `AiExperimentSummary`, `AiExperimentConclusion`, `AiRecommendation`); see `docs/EVENT_SCHEMA.md`.*
* *OpenTelemetry GenAI semantic convention mapping — span attributes follow OTel GenAI conventions for portability.*
* *Hook collector binary — `nr-ai-observe` CLI for AI client integration.*
