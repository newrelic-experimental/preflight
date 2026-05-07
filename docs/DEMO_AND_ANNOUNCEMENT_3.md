# NR AI Observatory — Wave 3 Slack Message & Demo Script

---

## Slack Message (Team Dev Channel)

> Hey team :wave:
>
> Wave 3 of the NR AI Observatory just landed. Six new roadmap items shipped this week, plus a round of pricing engine fixes. Here's what's new.
>
> **What shipped:**
>
> **1. Cost Budgets and Forecasting** — You can now set `sessionBudgetUsd`, `dailyBudgetUsd`, and `weeklyBudgetUsd` in config. The new `BudgetTracker` watches accumulated spend against those caps and emits warning events to New Relic at 50%, 80%, and 100%. Two new MCP tools: `nr_observe_get_budget_status` (are we over?) and `nr_observe_get_cost_forecast` (extrapolates current-session burn rate against the weekly trend).
>
> **2. Platform Adapters: Zed, Continue.dev, Amazon Q** — The observatory now supports three more AI coding platforms alongside Claude Code, Cursor, Windsurf, and Copilot. Each adapter normalizes platform-specific tool names into the shared vocabulary, so the same dashboards and NRQL queries work regardless of which tool a developer uses.
>
> **3. Four New Metric Trackers** — Four new analytics classes, four new MCP tools:
> - `nr_observe_get_context_efficiency` — measures repeated-read ratio as a proxy for context waste (how often is the AI re-reading files it already read?)
> - `nr_observe_get_latency_percentiles` — p50/p95/p99 latency per tool type across the session
> - `nr_observe_get_task_completion_rate` — task lifecycle tracking: detected → in-progress → completed vs. abandoned
> - `nr_observe_get_model_usage` — which model was used per request, with cost-efficiency ratios across models
>
> **4. Team and Org Analytics** — All NR events and metrics are now tagged with `teamId`, `projectId`, and `orgId`. `projectId` is auto-derived from the git remote URL if not explicitly configured. A new `nr_observe_get_team_summary` MCP tool queries aggregated team-level data. There's also a new manager dashboard that shows cost allocation by developer, project, and sprint — without exposing any tool-call content.
>
> **5. Developer Experience** — Three DX improvements in one shot:
> - `npx nr-ai-mcp-server setup` — interactive setup wizard; walks through NR account ID, API key, hook install, and first dashboard deploy in one session
> - `nr_observe_subscribe_digest` — register a Slack webhook for a weekly cost + efficiency summary, delivered automatically
> - `retainSessionsDays` config field — automatic purge of old session files; GDPR-friendly data minimization
>
> **6. AWS Bedrock, Mistral, and Cohere SDK Wrappers** — `nr-ai-agent` now covers every major enterprise AI provider. `wrapBedrockClient()`, `wrapMistralClient()`, and `wrapCohereClient()` follow the same pattern as the existing Anthropic, Gemini, and OpenAI wrappers — intercept calls, record latency and token counts, ship to NR. The `provider` field in NR events now distinguishes all six providers.
>
> **Also: pricing engine fixes** — Found and fixed four bugs in the cost calculation layer:
> - `claude-opus-4-7` was resolving to an old entry at $15/MTok instead of the correct $5/MTok (3× overcharge)
> - OpenAI `cacheReadTokens` was hardcoded to 0 — cached tokens were being billed at the full input rate, not the 10× cheaper cached rate
> - Anthropic `totalTokens` was missing cache token counts from the total
> - Model resolution could match `gemini-2.5-flash-lite` for a `gemini-2.5-flash` query
>
> Also updated the pricing table to May 2026 rates: Claude 4.7/4.6, Gemini 2.5 series (including flat pricing for Gemini 2.5 Flash), GPT-5.x family.
>
> **All of this is in one PR. Build is green, 1,630 tests, lint clean.**
>
> The setup wizard is probably the most immediately useful thing for anyone who wants to try this — it removes the manual config steps. Happy to walk anyone through it live.
>
> — @cdehaan

---

## Demo Video Script (4-5 minutes)

### Opening (15 seconds)

**[Screen: Terminal with Claude Code open]**

"Christopher de Haan here. Wave 3 of the NR AI Observatory — six new features, some pricing fixes, and a new onboarding path. I'll keep this tight. If you haven't seen the earlier demos, short version: it's an MCP server that ships AI coding assistant telemetry to New Relic."

---

### Feature 1 — Cost Budgets (30 seconds)

**[Screen: `~/.nr-ai-observe/config.json`]**

"First: cost budgets. Three new config fields."

```json
{
  "sessionBudgetUsd": 1.00,
  "dailyBudgetUsd": 5.00,
  "weeklyBudgetUsd": 20.00
}
```

"Once those are set, the BudgetTracker watches your accumulated spend. When you hit 50%, 80%, or 100% of any cap, it emits a warning event to New Relic — alertable. And there's a new MCP tool:"

**[Call `nr_observe_get_budget_status`]**

"Budget status: $0.43 of $1.00 session budget used, 43%. Forecasted session total: $0.61. No alert. That's live, per-session, no query required."

---

### Feature 2 — New Platform Support (20 seconds)

**[Screen: `platforms/` directory listing]**

"Second: three new platform adapters. Zed, Continue.dev, and Amazon Q Developer now join Claude Code, Cursor, Windsurf, and Copilot. Each adapter translates platform-specific tool names into the shared vocabulary."

**[Screen: NR One, NRQL faceted by platform]**

```nrql
FROM AiToolCall SELECT count(*) FACET platform SINCE 1 week ago
```

"If your team uses different tools, you can now see all of them in one query."

---

### Feature 3 — Four New Metric Trackers (45 seconds)

**[Screen: Claude Code, call `nr_observe_get_context_efficiency`]**

"Third: four new tracker classes and four new MCP tools. The one I find most interesting is context efficiency."

**[Show output: repeatedReadRatio, topRepeatedFiles]**

"Repeated-read ratio: 0.31. Three files read more than twice. That's a signal that the model is losing context and re-reading rather than retaining. When this number is high, your cost is going up and your efficiency score is going down."

**[Call `nr_observe_get_latency_percentiles`]**

"Latency percentiles per tool type: p50 42ms, p95 180ms, p99 430ms. Bash is consistently slower — that's expected. But if a Read is suddenly at p99, something's wrong."

**[Call `nr_observe_get_model_usage`]**

"Model usage breakdown: 100% claude-sonnet-4-6, $0.43 this session, cost per task $0.09. When you're multi-model, this is where you compare them."

---

### Feature 4 — Team Analytics (30 seconds)

**[Screen: `config.json` with teamId/projectId]**

"Fourth: team and org analytics. Add `teamId` and `projectId` to your config — or let the system derive `projectId` from your git remote — and every event gets tagged with those dimensions."

**[Screen: NR One, open the new manager dashboard]**

"This is the new manager dashboard. Cost per developer, efficiency score per developer, tool call breakdown by project, anti-pattern frequency by sprint. None of this exposes tool-call content — it's aggregate."

**[Call `nr_observe_get_team_summary`]**

"And the MCP tool version, if you want it inline: team summary for the last 7 days. Three developers, total spend $12.40, average efficiency 74/100."

---

### Feature 5 — Developer Experience (30 seconds)

**[Screen: Terminal]**

"Fifth: DX improvements. The biggest one is the setup wizard."

```bash
npx nr-ai-mcp-server setup
```

**[Show interactive prompts]**

"Enter your NR account ID, paste your license key, set your developer name, install hooks — done. It optionally deploys dashboards and alert conditions at the end. First-time setup that used to take 15 minutes of reading docs now takes 90 seconds."

**[Screen: Slack with a weekly digest message]**

"There's also a weekly digest. `nr_observe_subscribe_digest` registers a Slack webhook. Every Monday morning, you get a summary: last week's cost, efficiency trend, top anti-patterns, model breakdown. No dashboards required."

---

### Feature 6 — Bedrock, Mistral, Cohere Wrappers (25 seconds)

**[Screen: Code editor, show `wrappers/` directory]**

"Sixth: `nr-ai-agent` now covers every major enterprise AI provider."

```typescript
import { wrapBedrockClient, wrapMistralClient, wrapCohereClient } from 'nr-ai-agent';
```

"AWS Bedrock — both `InvokeModel` and streaming. Mistral SDK. Cohere SDK. Same one-line wrap, same `AiRequest` events in New Relic, same pricing table."

**[Screen: NR One, NRQL faceted by provider]**

```nrql
FROM AiRequest SELECT sum(cost_usd) FACET provider SINCE 1 month ago
```

"Six providers in one query. If you're using Bedrock for some models and OpenAI for others, you now have a single view of total AI spend."

---

### The Pricing Fixes (20 seconds)

**[Screen: pricing-data.ts or a diff view]**

"One more thing — not a feature, but important. We found and fixed four pricing calculation bugs. The most significant: `claude-opus-4-7` was resolving to an old table entry at $15 per million tokens instead of $5. Three-times overcharge on every Opus call. Also fixed: OpenAI cached tokens were being billed at the full input rate — up to ten times the correct price on GPT-5.x models with prompt caching enabled."

"Updated rates cover Claude 4.7 and 4.6, the full Gemini 2.5 family, and the GPT-5 series."

---

### Close (10 seconds)

**[Screen: Terminal with setup wizard running]**

"That's Wave 3. Setup wizard if you want to try it — `npx nr-ai-mcp-server setup`. Six features, 1,630 tests, one PR. Code is open inside the org. Thanks for watching."

---

## Production Notes

- **Total runtime target:** ~4:30
- **Screen recording tool:** QuickTime or OBS (terminal + browser side by side)
- **Key NRQL queries to have ready:**
  - `FROM AiToolCall SELECT count(*) FACET platform SINCE 1 week ago`
  - `FROM AiRequest SELECT sum(cost_usd) FACET provider SINCE 1 month ago`
  - `FROM AiRequest SELECT sum(cost_usd) FACET developer SINCE 1 week ago` (manager dashboard)
  - `FROM AiBudgetEvent SELECT latest(percentUsed) FACET budgetType SINCE 1 day ago`
- **MCP tools to demo (in order of impact):**
  - `nr_observe_get_budget_status` — concrete, instant, everyone has a budget question
  - `nr_observe_get_context_efficiency` — the most novel metric; repeated-read ratio isn't something anyone else is tracking
  - `nr_observe_get_team_summary` — sells the multi-developer story
  - `nr_observe_get_model_usage` — relevant to anyone running mixed-provider workloads
- **Dashboards to have open:**
  - Manager dashboard (new in Wave 3 — most visually distinctive)
  - Overview dashboard (shows the new `teamId`/`projectId` facets)
- **Before recording:**
  - Run the setup wizard on a fresh config so the interactive prompts are real
  - Set a session budget low enough that it's at ~40-50% during the demo (makes `get_budget_status` interesting)
  - Have at least two sessions in NR with different `teamId` values so the team summary has data
  - Register a real Slack webhook for the digest demo (or show a screenshot of a real digest)
- **Tip for live walkthroughs:** Lead with the pricing fixes if the audience is budget-conscious — "we found a bug that was overcharging you 3× on Opus" lands immediately. Save the team analytics story for last; it's the one that prompts "could we use this org-wide?" conversations.
