# NR AI Observatory — Wave 4 Slack Message & Demo Script

---

## Slack Message (Team Dev Channel)

> Hey team :wave:
>
> Wave 4 of the NR AI Observatory just landed. Four new features this time, all centered on a single theme: **making the observatory personal**.
>
> **What shipped:**
>
> **1. Developer Identity** — The `developer` field is now a first-class, normalized identifier throughout the system. It resolves automatically from `$USER` → `$USERNAME` → `git config user.name` → `unknown`, but you can override it with the `NEW_RELIC_AI_MCP_DEVELOPER` env var. The name is normalized to lowercase with underscores (`"John Doe"` → `"john_doe"`) so NRQL `WHERE developer = ...` queries are consistent across machines. It's now surfaced in `nr_observe_get_session_stats` so you can confirm your identity without reading the config file.
>
> **2. Personal Dashboard** — One command now deploys the personal dashboard pre-filtered to a single developer:
> ```
> NEW_RELIC_API_KEY=NRAK-xxxx NEW_RELIC_ACCOUNT_ID=1234567 \
>   npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts \
>   ai-coding-assistant-personal.json --developer cdehaan --staging
> ```
> The dashboard injects your developer name as the default template variable value — so it opens on your data, not the team aggregate. Same idempotent deploy/update/teardown lifecycle as the existing dashboards. If you skip `--developer`, it deploys without a default (useful for shared screens).
>
> **3. Developer-Scoped Alerts** — You can now configure personal alert thresholds in your config:
> ```json
> {
>   "alerts": {
>     "personal": {
>       "efficiencyScoreMin": 60,
>       "sessionCostUsd": 0.75,
>       "stuckLoopCountMax": 3
>     }
>   }
> }
> ```
> Then deploy conditions scoped to your developer name:
> ```
> NEW_RELIC_API_KEY=NRAK-xxxx NEW_RELIC_ACCOUNT_ID=1234567 \
>   npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --developer cdehaan --staging
> ```
> This creates a separate alert policy and condition set with NRQL `WHERE developer = 'cdehaan'` filters — so your alerts fire on your data, not the team aggregate. Useful if you have different cost tolerances or working patterns than the rest of the team.
>
> **4. Personal Coaching Report** — The most interesting one. A new MCP tool, `nr_observe_get_personal_insights`, generates a narrative coaching report by comparing this week's metrics against your own historical baseline. It computes deltas across efficiency, cost, anti-patterns, and task success rate — and surfaces a single top recommendation based on what's changed.
>
> The output reads like a coach, not a dashboard:
> ```
> This week your efficiency improved 8 points vs. your 4-week average.
> Cost per task is up 23% — driven by longer sessions, not more tool calls.
> Your anti-pattern rate dropped to 0.09 (personal best).
> Top recommendation: consider claude-haiku-4-5 for exploratory tasks
>   — you're using sonnet for short sessions where haiku would cost 25x less.
> ```
>
> It requires at least 2 weeks of session history. For new installs it returns `"insufficient_data"` with a message.
>
> **All four features are in one PR. Build is green, 2,190+ tests, lint clean.**
>
> The personal coaching report is probably the most interesting to demo — if you've been running the observatory for a few weeks, it can actually tell you something you didn't know. Happy to walk anyone through it.
>
> — @cdehaan

---

## Demo Video Script (4-5 minutes)

### Opening (15 seconds)

**[Screen: Terminal with Claude Code open]**

"Christopher de Haan here. Wave 4 of the NR AI Observatory — four features, all about making the observability personal. Previous waves were about capturing data; this one is about what you do with your data. Quick disclaimer: this wave works best when you've been running the observatory for a couple of weeks and have real session history."

---

### Feature 1 — Developer Identity (30 seconds)

**[Screen: Terminal — `nr_observe_get_session_stats` output]**

"First: developer identity. Every event the observatory emits already carried a `developer` field, but it wasn't normalized — so 'John Doe' on one machine might be 'johndoe' on another, and NRQL `WHERE developer = ...` queries would silently miss data."

"Now there's `normalizeDeveloperName()` — lowercase, spaces to underscores, consistent across machines. And it's surfaced in `get_session_stats` so you can see exactly what identifier you're using."

**[Show the `identity` block in the stats output]**

```json
{
  "identity": {
    "developer": "cdehaan",
    "teamId": "platform",
    "projectId": "nr-ai-observatory"
  }
}
```

"No more guessing what name your data is tagged with."

---

### Feature 2 — Personal Dashboard (40 seconds)

**[Screen: Terminal — deploy command]**

"Second: personal dashboard. One command:"

```bash
NEW_RELIC_API_KEY=NRAK-xxxx NEW_RELIC_ACCOUNT_ID=1234567 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts \
  ai-coding-assistant-personal.json --developer cdehaan --staging
```

**[Screen: NR One — dashboard opens]**

"This deploys a dashboard with your developer name baked in as the default template variable. When it opens, it's already filtered to your data."

**[Show the dashboard pages]**

"Timeline, task breakdown, file access patterns, anti-pattern history — all scoped to you. You can still change the developer filter at the top if you want to look at a teammate's data. But by default, it's yours."

"Same lifecycle as the team dashboards — idempotent, update command if the JSON changes, teardown command to remove it. If you already have the team dashboards deployed, this is one extra command."

---

### Feature 3 — Developer-Scoped Alerts (40 seconds)

**[Screen: `~/.nr-ai-observe/config.json`]**

"Third: developer-scoped alerts. Add this to your config:"

```json
{
  "alerts": {
    "personal": {
      "efficiencyScoreMin": 60,
      "sessionCostUsd": 0.75,
      "stuckLoopCountMax": 3
    }
  }
}
```

"Then deploy:"

```bash
NEW_RELIC_API_KEY=NRAK-xxxx NEW_RELIC_ACCOUNT_ID=1234567 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --developer cdehaan --staging
```

**[Screen: NR One — alert policy]**

"This creates a separate policy — 'AI Coding — Personal — cdehaan' — with conditions that have `WHERE developer = 'cdehaan'` in the NRQL. The conditions fire on your data specifically, not the team aggregate."

"Why does this matter? If you're a senior engineer who moves fast with high cost per task, the team-level efficiency alert might page you constantly. But your personal threshold might be higher — or you might care more about anti-pattern rate than raw cost. Now you can configure that separately."

---

### Feature 4 — Personal Coaching Report (60 seconds)

**[Screen: Claude Code — call `nr_observe_get_personal_insights`]**

"The fourth feature is the one I'm most interested in. `nr_observe_get_personal_insights` generates a narrative coaching report — not a dashboard, not a table, a narrative. It compares this week's metrics against your own historical baseline."

**[Show the output]**

"Let me read the output from my account:"

```
This week your efficiency improved 8 points vs. your 4-week average (74 → 82).
Cost per task is up 23% — driven by longer sessions, not more tool calls.
Your anti-pattern rate dropped to 0.09 — a personal best.

Streak: 3 consecutive weeks above your efficiency baseline.

Top recommendation: consider claude-haiku-4-5 for exploratory tasks.
You're using claude-sonnet-4-6 for sessions under 10 tool calls, where haiku
would cost 25x less with comparable quality for short exploration tasks.
```

"This is 8 weeks of my own history running through a comparison engine. The efficiency number going up is good. The cost per task going up is a flag — but it's explained: longer sessions, not inefficiency. The streak counter is a bit of gamification."

**[Pause on the recommendation]**

"The recommendation is what I find most useful. It looked at my model usage patterns and noticed I'm using Sonnet for short exploratory sessions where Haiku would be just as effective at a fraction of the cost. That's not something I'd have noticed from a dashboard."

"Two caveats: it requires at least 2 weeks of session history, and the recommendations are based on patterns — they're suggestions, not directives. But after a month of real data, it starts to feel like actual coaching."

"If you have existing NR telemetry but no local session files, there's a backfill script that seeds your local history from NR data so you don't have to wait:"

```bash
NEW_RELIC_API_KEY=NRAK-xxxx NEW_RELIC_ACCOUNT_ID=1234567 \
  npx tsx packages/nr-ai-mcp-server/scripts/backfill-sessions.ts \
  --developer cdehaan [--days 90] [--dry-run] [--staging]
```

---

### Putting It Together (20 seconds)

**[Screen: NR One — personal dashboard open]**

"So: Wave 4 is four features that work together. Your identity is normalized and visible. Your dashboard is pre-filtered to your data. Your alerts are tuned to your thresholds. And the coaching report tells you what changed and why."

"This is the thing I was actually trying to build from the beginning — observability that's useful to you specifically, not just useful in aggregate. The team dashboards from Wave 3 tell a manager what the team is doing. This wave tells you what you're doing."

---

### Close (15 seconds)

**[Screen: Terminal — `nr_observe_get_personal_insights` output]**

"That's Wave 4. If you've been running the observatory for a few weeks, `nr_observe_get_personal_insights` is the thing to try — it's more interesting when there's real history behind it. Code is open inside the org. Thanks for watching."

---

## Production Notes

- **Total runtime target:** ~4:00
- **Screen recording tool:** QuickTime or OBS (terminal + browser side by side)
- **Key NRQL queries to have ready:**
  - `FROM AiToolCall SELECT count(*) WHERE developer = 'cdehaan' SINCE 1 week ago TIMESERIES`
  - `FROM AiCodingTask SELECT average(efficiency_score) WHERE developer = 'cdehaan' FACET week(timestamp) SINCE 8 weeks ago`
  - `FROM AiAntiPattern SELECT count(*) WHERE developer = 'cdehaan' FACET pattern_type SINCE 1 month ago`
- **MCP tools to demo (in order of impact):**
  - `nr_observe_get_session_stats` — show the `identity` block (quick, concrete, proves normalization works)
  - `nr_observe_get_personal_insights` — lead with the output, read it aloud; it speaks for itself
- **Dashboards to have open:**
  - Personal dashboard (new in Wave 4 — deploy with `--developer` before recording)
  - Leave the developer filter visible so viewers can see it's pre-populated
- **Alert policy to have open:**
  - Personal alert policy in NR One (deploy with `--developer` before recording)
  - Having one condition in "warning" state during the demo makes the story more concrete
- **Before recording:**
  - Run `normalizeDeveloperName` with a few inputs in a REPL to show the consistency story (`"John Doe"` → `"john_doe"`)
  - Ensure at least 2 weeks of real session data in NR so `get_personal_insights` returns a real report, not `"insufficient_data"`. If local session files are missing, run the backfill script first: `npx tsx packages/nr-ai-mcp-server/scripts/backfill-sessions.ts --developer cdehaan --staging`
  - Set a `sessionCostUsd` low enough that it's near the threshold during the demo session — makes the personal alert story land
- **Tips for live walkthroughs:**
  - Lead with `get_personal_insights` if the audience already knows what the observatory does — skip the setup story and go straight to the output
  - The coaching report is the most shareable output; copy-paste it into Slack before the call so people can read it while you talk through it
  - The developer-scoped alerts story resonates most with senior engineers who've been frustrated by team-level alerts firing on their atypical (but intentional) usage patterns
