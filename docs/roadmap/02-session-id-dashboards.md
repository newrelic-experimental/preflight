# Implementation Plan: Session ID Dashboard Updates

**Roadmap item:** [02 — Session ID Dashboard Updates](../../ROADMAP.md#2-session-id-dashboard-updates)
**Effort estimate:** ~half day
**Prerequisites:** Session Trace ID (item 01) must be merged — `session_id` must be present on `AiToolCall`, `AiCodingTask`, and `AiAntiPattern` events

---

## Goal

Surface `session_id` in the New Relic dashboards so users can drill into a single session's activity. Two complementary changes:

1. **Add a `session_id` template variable to the 4 existing dashboards** — makes every widget filterable by session without changing their aggregate behavior when the variable is unset.
2. **Create a new session detail dashboard** — a dedicated per-session drill-down with widgets designed for timeline and attribution analysis, not cross-session comparison.

---

## File Paths

### Existing dashboards to update (add template variable)

- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-overview.json`
- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-security.json`
- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-platform-comparison.json`
- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-team-view.json`

### New file to create

- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-session-detail.json`

---

## Changes to Existing Dashboards

### 1. Add a `session_id` template variable

Each dashboard's top-level JSON object contains a `pages` array. Add a `variables` array at the same level:

```json
"variables": [
  {
    "name": "session_id",
    "title": "Session ID",
    "type": "NRQL",
    "nrqlQuery": {
      "query": "SELECT uniques(session_id) FROM AiToolCall SINCE 7 days ago LIMIT 100"
    },
    "isMultiSelection": false,
    "defaultValues": [],
    "replacementStrategy": "STRING"
  }
]
```

### 2. Inject the variable into every NRQL query

For each widget whose query targets `AiToolCall`, `AiCodingTask`, or `AiAntiPattern`, append a `WHERE` clause using the variable. If a query already has a `WHERE`, append with `AND`.

Pattern when no existing WHERE:
```
... FROM AiToolCall {{#session_id}} WHERE session_id = '{{session_id}}' {{/session_id}} SINCE ...
```

Pattern when WHERE already exists:
```
... FROM AiToolCall WHERE existing_filter = true {{#session_id}} AND session_id = '{{session_id}}' {{/session_id}} SINCE ...
```

Queries against `Metric` do **not** support this variable — skip them.

---

## New Dashboard: Session Detail

**File:** `ai-coding-assistant-session-detail.json`

This dashboard requires `session_id` to be set — it is not useful as an aggregate view. The template variable uses the same definition as above.

### Page: Session Overview

| Widget title | Visualization | NRQL |
|---|---|---|
| Total tool calls | Billboard | `SELECT count(*) AS 'Tool Calls' FROM AiToolCall WHERE session_id = '{{session_id}}' SINCE 8 hours ago` |
| Session cost | Billboard | `SELECT sum(estimated_cost_usd) AS 'Cost (USD)' FROM AiCodingTask WHERE session_id = '{{session_id}}' SINCE 8 hours ago` |
| Success rate | Billboard | `SELECT percentage(count(*), WHERE success = true) AS 'Success %' FROM AiToolCall WHERE session_id = '{{session_id}}' SINCE 8 hours ago` |
| Anti-patterns detected | Billboard | `SELECT count(*) AS 'Anti-Patterns' FROM AiAntiPattern WHERE session_id = '{{session_id}}' SINCE 8 hours ago` |
| Tool call timeline | Line | `SELECT count(*) FROM AiToolCall WHERE session_id = '{{session_id}}' FACET tool TIMESERIES 1 minute SINCE 8 hours ago` |
| Tool call breakdown | Bar | `SELECT count(*) FROM AiToolCall WHERE session_id = '{{session_id}}' FACET tool SINCE 8 hours ago` |
| Error breakdown | Bar | `SELECT count(*) FROM AiToolCall WHERE session_id = '{{session_id}}' AND success = false FACET tool SINCE 8 hours ago` |
| Average latency by tool | Bar | `SELECT average(duration_ms) AS 'Avg ms' FROM AiToolCall WHERE session_id = '{{session_id}}' FACET tool SINCE 8 hours ago` |

### Page: Tasks & Files

| Widget title | Visualization | NRQL |
|---|---|---|
| Tasks in session | Table | `SELECT task_id, tool_calls, estimated_cost_usd, tests_passed FROM AiCodingTask WHERE session_id = '{{session_id}}' SINCE 8 hours ago` |
| Files read | Table | `SELECT uniqueCount(filePath) AS 'Reads', latest(timestamp) AS 'Last Read' FROM AiToolCall WHERE session_id = '{{session_id}}' AND tool = 'Read' FACET filePath SINCE 8 hours ago LIMIT 50` |
| Files modified | Table | `SELECT count(*) AS 'Edits' FROM AiToolCall WHERE session_id = '{{session_id}}' AND tool IN ('Edit', 'Write') FACET filePath SINCE 8 hours ago LIMIT 50` |
| Anti-pattern breakdown | Bar | `SELECT count(*) FROM AiAntiPattern WHERE session_id = '{{session_id}}' FACET type SINCE 8 hours ago` |

---

## Acceptance Criteria

- [ ] `npm run build` passes (no TypeScript errors — dashboard JSONs are static but the deploy script may reference them)
- [ ] `npm test` passes (no test changes needed — dashboards are JSON, no unit tests)
- [ ] `npm run lint` passes (0 errors, 0 warnings)
- [ ] All 4 existing dashboards have a `variables` section with the `session_id` variable
- [ ] All NRQL queries against event types (not Metric) in existing dashboards include the `{{#session_id}}` filter injection
- [ ] New session detail dashboard file exists with 2 pages and 12 widgets
- [ ] The `session_id` variable in the new dashboard is required (no meaningful data without it)
- [ ] Deploy script (`scripts/deploy-dashboard.ts` or equivalent) can deploy the new dashboard without modification — it should iterate all JSON files in the `dashboards/` directory

---

## Verification

After deploying to a New Relic account:

1. Open any existing dashboard → confirm the "Session ID" dropdown appears in the filter bar
2. Select a session UUID from the dropdown → confirm all event-based widgets filter to that session; Metric widgets show unchanged aggregate data
3. Open the session detail dashboard → select a session UUID → confirm all widgets populate with data for that specific session
4. Leave session ID unset in an existing dashboard → confirm behavior is identical to pre-change (no WHERE clause injected, full aggregate view)
