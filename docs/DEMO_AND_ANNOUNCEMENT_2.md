# NR AI Observatory — Wave 2 Slack Message & Demo Script

---

## Slack Message (Team Dev Channel)

> Hey team :wave:
>
> Quick update on the NR AI Observatory side project — I shipped five new features this week and wanted to share what's new.
>
> **What shipped:**
>
> **1. Session Trace IDs** — Every event, metric, and log from a session now carries a shared `session_id`. You can do `WHERE session_id = 'abc123'` in NRQL and get a complete, joinable picture of a single session — cost, tool calls, anti-patterns, all in one query.
>
> **2. Session Detail Dashboard** — New dedicated dashboard with per-session timeline, task breakdown, file access patterns, and anti-pattern widgets. The four existing dashboards were also updated with a `session_id` template variable so you can scope any widget to a single session.
>
> **3. Pre-built Alert Conditions** — One command (`nr-ai-mcp-server alerts deploy`) now deploys a full set of NRQL alert conditions: cost spikes, low efficiency, stuck loop rate, anti-pattern frequency, and budget overruns. Same UX as the dashboard deploy — idempotent, dry-run mode, teardown command.
>
> **4. OpenAI SDK Wrapper** — `nr-ai-agent` now wraps the OpenAI SDK alongside Anthropic and Gemini. Covers GPT-4o, o1, o3 family — streaming and non-streaming, including reasoning tokens. 13 new models in the pricing table.
>
> **5. CI/CD Integration** — There's now a GitHub Actions composite action and a GitLab CI job template that reads session telemetry for a branch, computes cost and efficiency deltas vs. the baseline, and posts a structured comment on the pull request. Pass/fail threshold is configurable — you can actually fail a PR if the AI efficiency score drops below a threshold.
>
> The PR comment looks like this:
> ```
> 🤖 AI Coding Report — feature/my-branch
> Cost delta:     +$0.12  (was $0.31, now $0.43)
> Efficiency:     78/100  (↓4 from baseline)
> Anti-patterns:  2 (re-read ×1, blind edit ×1)
> Model:          claude-sonnet-4-6 (100%)
> ```
>
> **All five features landed in one PR this week.** Build is green, 1,350 tests, lint clean.
>
> Still a side project — but it's starting to feel like something real. Would love feedback on any of these, especially the CI/CD piece — that one feels like it could be genuinely useful to other teams.
>
> — @cdehaan

---

## Demo Video Script (3-4 minutes)

### Opening (15 seconds)

**[Screen: Terminal with Claude Code open]**

"Hey, Christopher de Haan here. I shipped five new features to the NR AI Observatory this week, and I want to walk through what they do. This is the 'Wave 2' demo — if you haven't seen the first one, the short version is: it's an MCP server that ships AI coding assistant telemetry to New Relic."

---

### Feature 1 — Session Trace ID (30 seconds)

**[Screen: Claude Code session, call `nr_observe_get_session_stats`]**

"The first thing I added is a session trace ID. Every session now generates a UUID at startup — and that ID is stamped on every NR event, every metric, and every log line emitted during that session."

**[Screen: NR One, run NRQL query]**

"In New Relic, that means I can do this:"

```nrql
FROM AiToolCall SELECT *
WHERE session_id = '{{session_id}}'
SINCE 1 hour ago
```

"Every tool call, every task event, every anti-pattern — all joinable by one attribute. Before this, you had to approximate with time windows. Now sessions are first-class."

---

### Feature 2 — Session Detail Dashboard (30 seconds)

**[Screen: NR One, open the new session detail dashboard]**

"I also shipped a new dedicated session dashboard. It has two pages — an overview and a deep dive. Timeline of tool calls, task detection, file access heatmap, anti-pattern breakdown. And I added a session ID template variable to all four existing dashboards, so you can scope any widget to a single session."

**[Click the session_id dropdown, select a session]**

"Pick a session ID, and the whole dashboard filters. You can walk through a specific coding session in detail."

---

### Feature 3 — Pre-built Alerts (30 seconds)

**[Screen: Terminal]**

"Third thing: pre-built alert conditions. One command:"

```bash
nr-ai-mcp-server alerts deploy
```

"That deploys a full set of NRQL alert conditions — cost spike, low efficiency score, stuck loop rate, anti-pattern frequency, and a budget exceeded alert. Same idempotent design as the dashboard deploy. Dry-run mode, teardown command."

**[Screen: NR One, show the alert policy]**

"Here's what it looks like in NR One after deploy. Five conditions, one policy, ready to notify."

---

### Feature 4 — OpenAI SDK Wrapper (30 seconds)

**[Screen: Code editor, show `wrappers/openai.ts`]**

"Fourth: OpenAI support. The `nr-ai-agent` package now has an OpenAI wrapper alongside the existing Anthropic and Gemini ones. You call `wrapOpenAiClient(client)` and from that point on, every chat completion — streaming or not — gets intercepted, costed, and shipped to NR."

"GPT-4o, o1, o3 family, reasoning tokens — all covered. 13 new models in the pricing table."

**[Screen: NR One, NRQL faceting by model]**

```nrql
FROM AiRequest SELECT sum(cost_usd) FACET model SINCE 1 week ago
```

"Now if your team uses multiple AI providers, you can see cost breakdown by model across all of them in one query."

---

### Feature 5 — CI/CD Integration (45 seconds)

**[Screen: GitHub PR, show the bot comment]**

"The last one is my favorite. There's now a GitHub Actions composite action — and a matching GitLab CI template — that runs on every PR. It queries NR for the branch's session telemetry, computes cost and efficiency deltas, and posts this comment:"

**[Zoom in on the PR comment]**

```
🤖 AI Coding Report — feature/my-branch
Cost delta:     +$0.12  (was $0.31, now $0.43)
Efficiency:     78/100  (↓4 from baseline)
Anti-patterns:  2 (re-read ×1, blind edit ×1)
Model:          claude-sonnet-4-6 (100%)
```

"And here's the part I think is interesting: you can set a threshold. If efficiency drops below 60, the status check fails. AI code quality — or at least AI cost efficiency — becomes part of the merge gate."

**[Screen: Show the workflow YAML]**

```yaml
- uses: nr-ai-observatory/actions/ai-report@v1
  with:
    new-relic-api-key: ${{ secrets.NR_API_KEY }}
    account-id: ${{ secrets.NR_ACCOUNT_ID }}
    fail-below: 60
```

"Two secrets, one action. That's the whole integration."

---

### Why It Matters (20 seconds)

**[Screen: NR One with the session detail dashboard open]**

"Session trace IDs make every signal joinable. Alerts mean you don't have to check — you get paged. OpenAI support means this isn't just a Claude Code tool anymore. And the CI/CD integration brings AI observability into code review."

"This started as a NRQL learning project. It's turning into something that could genuinely be useful — either as an internal platform tool or as a customer-facing feature. Five features, one week, one PR."

---

### Close (10 seconds)

**[Screen: GitHub repo or Slack channel]**

"That's Wave 2 of the NR AI Observatory. Code is open inside the org. Happy to walk anyone through setup or the CI/CD piece specifically — that one's the most immediately shareable. Thanks for watching."

---

## Production Notes

- **Total runtime target:** ~3:30
- **Screen recording tool:** QuickTime or OBS (terminal + browser side by side)
- **Key NRQL queries to have ready:**
  - `FROM AiToolCall SELECT * WHERE session_id = '{{session_id}}' SINCE 1 hour ago`
  - `FROM AiRequest SELECT sum(cost_usd) FACET model SINCE 1 week ago`
  - `FROM AiAntiPattern SELECT count(*) FACET pattern_type SINCE 1 day ago`
- **MCP tools to demo:**
  - `nr_observe_get_session_stats` (shows session ID in output)
  - `nr_observe_get_efficiency_score` (context for the CI/CD threshold)
  - `nr_observe_get_anti_patterns` (bridges to the alert conditions story)
- **Dashboards to have open:**
  - Session Detail dashboard (new in Wave 2)
  - Any existing dashboard with the session_id template variable visible
- **Before recording:**
  - Run a real coding session so there's a valid `session_id` to demonstrate
  - Deploy the alerts in a test account so the NR One screenshot is real
  - Have a real PR open with the bot comment visible (or screenshot from a test run)
- **Tip:** The CI/CD feature is the most shareable — if you only have time for one thing in a live walkthrough, demo that one. It's the most legible to non-users.
