---
title: New Relic Scorecard Rules
description: Recommended Scorecard rules for team-level attribution of AI coding cost and health.
---

# NR AI Coding Observability: Preflight — Scorecard Rules

This document provides ready-to-use New Relic Scorecard rule definitions for Preflight's custom events. Scorecard rules let your teams track AI coding cost and efficiency without needing custom entity types — each rule runs a simple NRQL query that you create once in the New Relic UI (or via NerdGraph), and then shows progress (green/yellow/red) as your developers code. The rules below are starting points; adapt thresholds to match your team's actual velocity and budget.

Scorecard rules are created in the New Relic UI (**Teams > Scorecards > New rule**) or via the NerdGraph `EntityManagementScorecardEntity` / `EntityManagementScorecardRuleEntity` API. This document gives the exact NRQL queries and rationale, not a one-click import — there is no bulk import format for Scorecards. Copy the NRQL below into each rule's query field, adjust the threshold percentages to match your organization's standards, and let the dashboard run.

---

## Scorecard Rules

### 1. Weekly AI Cost per Team (7-day rolling)

**Rule Name:** `AI Coding Cost — Weekly Ceiling`

**NRQL Query:**

```nrql
FROM AiCodingTask SELECT sum(estimated_cost_usd) AS 'Weekly AI Cost (USD)'
WHERE team_id IS NOT NULL
FACET team_id SINCE 7 DAYS AGO
```

**Progress Levels:**

- **Green** (on track): < 50 USD
- **Yellow** (warning): 50–100 USD
- **Red** (over budget): ≥ 100 USD

**Rationale:** Tracks cumulative AI session cost per team over a rolling 7-day window. Adjust the USD thresholds based on your licensing model and burn-rate tolerance; these defaults assume low-to-moderate usage. Escalate to your manager if red.

---

### 2. Anti-Pattern Detection Rate per Team (7-day rolling)

**Rule Name:** `AI Thrashing & Anti-patterns — Team Rate`

**NRQL Query:**

```nrql
FROM AiAntiPattern SELECT count(*) AS 'Anti-Pattern Count (7 days)'
WHERE team_id IS NOT NULL
FACET team_id SINCE 7 DAYS AGO
```

**Progress Levels:**

- **Green** (healthy): < 5 patterns
- **Yellow** (attention needed): 5–15 patterns
- **Red** (high waste): ≥ 15 patterns

**Rationale:** Counts all detected anti-patterns (thrashing, re-reading, stuck loops, blind editing, over-delegation) per team each week. Spikes indicate inefficient AI workflows that are burning tokens without progress; use this to flag teams for process review or prompt engineering coaching.

---

### 3. Average Efficiency Score per Team (30-day rolling)

**Rule Name:** `AI Efficiency Score — Team Average`

**NRQL Query:**

```nrql
FROM Metric SELECT average(ai.efficiency.score) AS 'Avg Efficiency (0–1)'
WHERE team_id IS NOT NULL
FACET team_id SINCE 30 DAYS AGO
```

**Progress Levels:**

- **Green** (excellent): ≥ 0.75
- **Yellow** (acceptable): 0.50–0.74
- **Red** (needs help): < 0.50

**Rationale:** Measures composite efficiency (speed, correctness, autonomy, first-attempt quality) per team averaged over 30 days. Scores above 0.75 indicate the AI is working directly; below 0.50 suggests repeated retries, corrections, or excessive back-and-forth. Track this to spot teams where your prompts or agent configuration need tuning.

---

### 4. Cost per File Modified per Team (7-day rolling)

**Rule Name:** `AI Cost Efficiency — Cost per File Changed`

**NRQL Query:**

```nrql
FROM AiCodingTask SELECT (sum(estimated_cost_usd) / sum(files_modified)) AS 'Cost per File (USD)'
WHERE team_id IS NOT NULL AND files_modified > 0
FACET team_id SINCE 7 DAYS AGO
```

**Progress Levels:**

- **Green** (efficient): < 2.00 USD per file
- **Yellow** (reasonable): 2.00–5.00 USD per file
- **Red** (expensive): ≥ 5.00 USD per file

**Rationale:** Normalizes session cost by the number of files actually modified, isolating spend on changes that shipped. High values indicate sessions where the AI spent a lot of tokens but touched very few files, suggesting either explorations that didn't ship or very large complex changes. Trend this metric to spot when your codebase or task definitions are becoming too verbose for the AI to navigate efficiently.

---

### 5. Security Alert Rate per Team (7-day rolling)

**Rule Name:** `AI Security Alerts — Destructive & Sensitive Access`

**NRQL Query:**

```nrql
FROM SecurityAlert SELECT count(*) AS 'Security Alerts (7 days)'
WHERE team_id IS NOT NULL
FACET team_id, alert_type SINCE 7 DAYS AGO
```

**Progress Levels:**

- **Green** (secure): 0 alerts
- **Yellow** (watch): 1–3 alerts (non-critical, non-destructive)
- **Red** (action required): ≥ 1 destructive command or sensitive file alert

**Rationale:** Alerts when the AI tool suite detects attempts to delete code, force-push, or access secrets. Zero is ideal; any destructive command is red. Use this scorecard to audit AI tool privileges and update your security rules if the AI is flagged for legitimate high-risk operations.

---

## Notes

- **Team ID matching:** Each scorecard rule facets by `team_id`, which must match an actual New Relic Team name or alias in your account for the FACET to line up. If you have not yet configured `team_id` in your Preflight config, all Preflight events will be missing the `team_id` attribute, and the scorecard will show no data. Set it via the `NEW_RELIC_AI_TEAM_ID` environment variable, or the `teamId` key in `~/.newrelic-preflight/config.json`, then restart your AI tool.
- **Thresholds are starting points:** Adjust Green/Yellow/Red levels to match your organization's burn rate, code velocity, and risk tolerance. A fast team shipping many files may need higher USD thresholds; a compliance-heavy team may want Red to fire at 0 security alerts.
- **Cross-team trends:** Create separate scorecard rules per team, or add additional NRQL rules scoped to `project_id` for per-repo cost attribution. See the `project_id` field in `docs/METRICS_TABLE.md` for the structure.

---

## Additional Resources

- **Event attributes:** See `docs/METRICS_TABLE.md` for the complete list of fields available on each event type (`AiCodingTask`, `AiAntiPattern`, `SecurityAlert`, etc.).
- **Query builder:** Open New Relic's **Query Builder** and paste any NRQL query above to test it with your live data before creating the scorecard rule.
- **NRQL docs:** [New Relic NRQL reference](https://docs.newrelic.com/docs/nrql/nrql-reference/nrql-syntax-clauses-functions/) for full query syntax and functions.
