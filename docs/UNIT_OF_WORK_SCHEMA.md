---
title: Unit of Agent Work Schema
description: A versioned view over existing New Relic events that describes one skill run, slash command, or subagent invocation.
---

# Unit of agent work schema

**Schema version: 1.**

This version is independent of the npm package version and of each event's `event_version`. It is published here only. No event carries it, so a consumer detects a breaking change by reading this page or the changelog, not by querying New Relic.

This schema is a view over existing events. A skill run or slash command has one `AiSkillRun` row, sent when the run opens, which names it. It also has one `AiWorkUnit` row, sent when it ends, which carries its duration and its tool calls' cost and tokens. A subagent invocation has neither, so you build its cost, tokens, and duration from the rows listed here, as you do a run's reply cost. Events reach New Relic only when export is on. Local mode sends none.

## One unit is a skill run, a slash command, or a subagent invocation

| Unit                | Key                         | Starts                                 | Ends                                                 |
| ------------------- | --------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Skill run           | `skill_run_id`              | A successful, named `Skill` tool call  | The next prompt or the next skill in the same agent  |
| Slash command       | `skill_run_id`              | A prompt that starts with `/<name>`    | The next prompt, or the next skill with another name |
| Subagent invocation | `agent_id` (AiSubagentTurn) | The subagent's first transcript record | The subagent's last transcript record                |

`skill_source` separates the first two units. Its value is `tool` for a skill run and `slash` for a slash command. A `Skill` call that names the open slash command's skill stays in the same run. A failed or unrun `Skill` call outside any run carries `skill_name` and `skill_source = 'tool'` with no `skill_run_id`. Inside an open run it carries that run's `skill_name`, `skill_source` and `skill_run_id`, so the failed skill's own name does not appear. To keep only rows inside a run, filter on `skill_run_id IS NOT NULL`.

Two other records are not units in this schema. `AiCodingTask` covers a detected task, which can span many units. A script-driven `AiWorkflowRun` covers a workflow of many agents.

A unit needs a `Skill` tool call or a `UserPromptSubmit` hook, so a platform without those hooks produces no skill runs or slash commands. `AiSubagentTurn` comes only from Claude Code transcripts.

## Every field maps to a source, or says it has none

Each status means one of the following:

- **Exact**: the attribute holds the value for the whole unit, or the rows add up to it.
- **Approximate**: the value is derived or split, and the note says how it can be wrong.
- **No source**: no emitted attribute holds this value.

### Skill runs and slash commands

| Field                | Source                                                                           | Status      | Note                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                 | `AiSkillRun.skill_name`, `AiToolCall.skill_name`, `AiTurnCost.skill_name`        | Exact       | Redacted like other user-derived strings. Includes built-in commands that send a prompt to the model, such as `/init`. Commands Claude Code handles locally, such as `/clear`, never reach Preflight.           |
| Model                | `AiTurnCost.model`                                                               | Approximate | Set per response, so one run can have several models. `AiToolCall` has no model.                                                                                                                                |
| Wall-clock duration  | None. Derive from `max(timestamp) - min(timestamp)` on `AiToolCall`              | No source   | The derived value starts at the first call's start and stops at the last call's start. It leaves out the response before the first call and everything after the last call starts. A one-call run reads as `0`. |
| Input, output tokens | `AiTurnCost.input_tokens`, `AiTurnCost.output_tokens`                            | Approximate | On a tool row, a fractional share of the response, split evenly across the calls in the burst before it. A response row carries its whole report. See [the gaps](#the-existing-events-leave-these-gaps).        |
| Cache tokens         | `AiTurnCost.cache_read_tokens`, `AiTurnCost.cache_creation_tokens`               | Approximate | Same split and same gaps as input and output tokens.                                                                                                                                                            |
| Cost                 | `AiTurnCost.cost_usd`                                                            | Approximate | Same split and same gaps.                                                                                                                                                                                       |
| Session id           | `AiSkillRun.session_id`, `AiToolCall.session_id`, `AiTurnCost.session_id`        | Exact       | Omitted when no session is known. A subagent's tool calls carry the main session's id plus `AiToolCall.agent_id`.                                                                                               |
| Parent-session id    | None                                                                             | No source   | `skill_parent_run_id` is a different thing. It names the run that was open when this run started, one hop only.                                                                                                 |
| Team, project, org   | `team_id`, `project_id`, `org_id` on `AiSkillRun`, `AiToolCall` and `AiTurnCost` | Exact       | Each is omitted when not configured or derived.                                                                                                                                                                 |

### Subagent invocations

`AiSubagentTurn` holds one row per subagent response, keyed by `agent_id`. `AiWorkflowRun` with `run_source = 'agent_tool'` holds one row per `Agent` tool call, keyed by `workflow_run_id`. No attribute joins these two rows for one invocation. Plain subagents send an empty `AiSubagentTurn.workflow_run_id`, and `AiWorkflowRun` has no `agent_id`. Treat `AiSubagentTurn` as the unit and use `AiWorkflowRun` only for totals by type.

| Field                | Source                                                                          | Status      | Note                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                 | `AiSubagentTurn.agent_type`, `AiWorkflowRun.subagent_type`                      | Approximate | `agent_type` is best effort and absent until a type has been seen for that `agent_id`. `subagent_type` is what the `Agent` call requested, and an empty string when the call named none.                                                                                                       |
| Model                | `AiSubagentTurn.model`                                                          | Exact       | Set per response, so facet on it if a subagent can change models. `AiWorkflowRun.agent_model` is only the `Agent` call's `model` input, and an empty string when the call set none.                                                                                                            |
| Wall-clock duration  | `AiWorkflowRun.duration_ms`, or `max(timestamp) - min(timestamp)` by `agent_id` | Approximate | `duration_ms` covers the `Agent` call, but it is not joinable to one `agent_id`. With `run_in_background = true` the call returns before the work finishes, so `duration_ms` measures the spawn. The derived value spans first response to last response and misses the time before the first. |
| Input, output tokens | `AiSubagentTurn.input_tokens`, `AiSubagentTurn.output_tokens`                   | Exact       | Whole counts per response.                                                                                                                                                                                                                                                                     |
| Cache tokens         | `AiSubagentTurn.cache_read_tokens`, `AiSubagentTurn.cache_creation_tokens`      | Exact       | Whole counts per response.                                                                                                                                                                                                                                                                     |
| Cost                 | `AiSubagentTurn.usd`                                                            | Approximate | Omitted when the response has no positive price (the model is unpriced, or its total is zero), so `sum(usd)` leaves out those responses.                                                                                                                                                       |
| Session id           | None. Use `agent_id`                                                            | No source   | A subagent has no session of its own. `agent_id` is the only id per invocation.                                                                                                                                                                                                                |
| Parent-session id    | `AiSubagentTurn.parent_session_id`, `AiWorkflowRun.session_id`                  | Exact       | Both name the session that spawned the subagent.                                                                                                                                                                                                                                               |
| Team, project, org   | `team_id`, `project_id`, `org_id` on both events                                | Exact       | Each is omitted when not configured or derived.                                                                                                                                                                                                                                                |

## The existing events leave these gaps

These gaps affect the questions a shared skill library asks. None has a fix inside this schema, because each needs an emitter change.

- **A reply at the end of a run can miss it or land on the next one.** A response row takes the run open when Preflight reads its report, which can lag the reply by about 2 seconds. A prompt sent inside that window can leave the last reply of the previous run without the stamp, or give it the stamp of a `/<skill>` the prompt opened.
- **A run with no tool calls has a duration only on `AiWorkUnit`.** Its `AiSkillRun` row names it, and its `AiTurnCost` response rows carry its cost and tokens, which its `AiWorkUnit` row leaves out. It has no `AiToolCall` row, so the duration recipe leaves it out. Count runs from `AiToolCall` and `AiSkillRun` together.
- **Subagent spend is not on the skill.** `AiSubagentTurn` has no `skill_*` attributes. The only link is `AiToolCall`, where a subagent's calls carry both `agent_id` and `skill_run_id`. A subagent that made no tool call, or whose calls had no `agent_id` when Preflight processed them, has no link. A subagent that opens its own skill links to two runs.
- **`AiTurnCost` rows on subagent calls hold main-agent cost.** Subagent tool calls enter the same burst as main-agent calls, so they take a share of the main agent's next response. The subagent's own spend is on `AiSubagentTurn`. The session total holds, but the split between skills can shift.
- **Run boundaries are inferred.** There is no signal for a skill returning, so work after a nested skill finishes stays on the nested run. A follow-up prompt ends the run, so later work on the same skill is not counted. A subagent keeps the run the main agent had open when the subagent first appeared, even after a later prompt, which can stretch the derived duration.
- **Skill runs have no version.** No attribute names the skill's revision or a hash of its content. A before-and-after comparison can split only on time, so a rewrite that reaches developers on different days mixes old and new runs in one window.
- **Some bursts are dropped.** When token reports stop arriving, the oldest waiting burst is evicted and its calls get no `AiTurnCost` rows.

### What each question gets from these events

| Question                                      | Answer                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Which skills are used?                        | Answered. `AiSkillRun` counts runs with no tool calls.                                                                  |
| What does each cost per run?                  | Partly answered. `AiWorkUnit` has each run's tool-call cost. Reply cost is on `AiTurnCost`. Subagents need a join.      |
| Did a rewrite make a skill cheaper or longer? | Partly answered. Compare two time windows of the approximate cost and duration. The events cannot identify the rewrite. |

## NRQL recipes answer each question within those gaps

Nobody has run these recipes against an account. They are syntax-checked by reading the [nested aggregation](https://docs.newrelic.com/docs/nrql/using-nrql/nested-aggregation-make-ordered-computations-single-query/) and [subquery join](https://docs.newrelic.com/docs/nrql/using-nrql/subquery-joins/) documentation only. A test checks that every attribute they name is in the catalog below.

To list the skills and slash commands in use:

```sql
FROM AiToolCall, AiSkillRun SELECT uniqueCount(skill_run_id) AS 'Runs', uniqueCount(developer) AS 'Users' WHERE skill_run_id IS NOT NULL FACET skill_name, skill_source SINCE 30 days ago LIMIT MAX
```

To list the subagent types in use:

```sql
FROM AiSubagentTurn SELECT uniqueCount(agent_id) AS 'Invocations' FACET agent_type SINCE 30 days ago LIMIT MAX
```

To get main-agent cost and tokens per run, counting runs with no tool calls:

```sql
FROM AiToolCall, AiTurnCost, AiSkillRun SELECT uniqueCount(skill_run_id) AS 'Runs', sum(cost_usd) / uniqueCount(skill_run_id) AS 'USD per run', sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) / uniqueCount(skill_run_id) AS 'Tokens per run' WHERE skill_run_id IS NOT NULL FACET skill_name SINCE 30 days ago LIMIT MAX
```

To get cost and tokens per subagent invocation:

```sql
FROM AiSubagentTurn SELECT sum(usd) / uniqueCount(agent_id) AS 'USD per invocation', sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) / uniqueCount(agent_id) AS 'Tokens per invocation' FACET agent_type SINCE 30 days ago LIMIT MAX
```

To add subagent spend to a skill, join on the link in `AiToolCall`. The join reads at most 5,000 subquery rows, and a subagent linked to two skills counts under both:

```sql
FROM AiSubagentTurn JOIN (FROM AiToolCall SELECT count(*) WHERE agent_id IS NOT NULL AND skill_run_id IS NOT NULL FACET agent_id, skill_name LIMIT MAX) ON agent_id SELECT sum(usd) AS 'Subagent USD' FACET skill_name SINCE 7 days ago
```

To get the approximate duration of a run, from first call to last call:

```sql
SELECT average(run_ms), percentile(run_ms, 50, 90) FROM (SELECT max(timestamp) - min(timestamp) AS run_ms FROM AiToolCall WHERE skill_run_id IS NOT NULL FACET skill_name, skill_run_id LIMIT MAX) FACET skill_name SINCE 30 days ago
```

To check whether a rewrite made a skill cheaper, run this once for a window before the rewrite and once for a window after it. Then run the duration recipe for the same two windows with `skill_name = 'my-skill'` added, which shows whether the skill also got longer. Allow for the rollout, because the events cannot separate old runs from new ones:

```sql
FROM AiToolCall, AiTurnCost, AiSkillRun SELECT uniqueCount(skill_run_id) AS 'Runs', sum(cost_usd) / uniqueCount(skill_run_id) AS 'USD per run', sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) / uniqueCount(skill_run_id) AS 'Tokens per run' WHERE skill_name = 'my-skill' AND skill_run_id IS NOT NULL SINCE '2026-10-01 00:00:00' UNTIL '2026-10-15 00:00:00'
```

## The attribute catalog marks each attribute stable or experimental

An attribute is stable when a dashboard in `dashboards/` reads it, or when it is one of the team attribution fields. Every other attribute is experimental. A test checks each row against the event its emitter builds.

| Event            | Attribute               | Stability    |
| ---------------- | ----------------------- | ------------ |
| `AiSkillRun`     | `timestamp`             | experimental |
| `AiSkillRun`     | `developer`             | stable       |
| `AiSkillRun`     | `session_id`            | stable       |
| `AiSkillRun`     | `skill_name`            | stable       |
| `AiSkillRun`     | `skill_source`          | stable       |
| `AiSkillRun`     | `skill_run_id`          | stable       |
| `AiSkillRun`     | `skill_parent_run_id`   | experimental |
| `AiSkillRun`     | `team_id`               | stable       |
| `AiSkillRun`     | `project_id`            | stable       |
| `AiSkillRun`     | `org_id`                | stable       |
| `AiToolCall`     | `timestamp`             | stable       |
| `AiToolCall`     | `tool_use_id`           | experimental |
| `AiToolCall`     | `developer`             | stable       |
| `AiToolCall`     | `session_id`            | stable       |
| `AiToolCall`     | `agent_id`              | experimental |
| `AiToolCall`     | `skill_name`            | stable       |
| `AiToolCall`     | `skill_source`          | stable       |
| `AiToolCall`     | `skill_run_id`          | stable       |
| `AiToolCall`     | `skill_parent_run_id`   | experimental |
| `AiToolCall`     | `team_id`               | stable       |
| `AiToolCall`     | `project_id`            | stable       |
| `AiToolCall`     | `org_id`                | stable       |
| `AiTurnCost`     | `tool`                  | experimental |
| `AiTurnCost`     | `tool_use_id`           | experimental |
| `AiTurnCost`     | `developer`             | stable       |
| `AiTurnCost`     | `session_id`            | stable       |
| `AiTurnCost`     | `model`                 | experimental |
| `AiTurnCost`     | `skill_name`            | stable       |
| `AiTurnCost`     | `skill_source`          | experimental |
| `AiTurnCost`     | `skill_run_id`          | stable       |
| `AiTurnCost`     | `skill_parent_run_id`   | experimental |
| `AiTurnCost`     | `cost_usd`              | stable       |
| `AiTurnCost`     | `input_tokens`          | stable       |
| `AiTurnCost`     | `output_tokens`         | stable       |
| `AiTurnCost`     | `cache_read_tokens`     | stable       |
| `AiTurnCost`     | `cache_creation_tokens` | stable       |
| `AiTurnCost`     | `team_id`               | stable       |
| `AiTurnCost`     | `project_id`            | stable       |
| `AiTurnCost`     | `org_id`                | stable       |
| `AiWorkUnit`     | `skill_run_id`          | experimental |
| `AiWorkUnit`     | `cost_usd`              | experimental |
| `AiWorkUnit`     | `duration_ms`           | experimental |
| `AiSubagentTurn` | `timestamp`             | experimental |
| `AiSubagentTurn` | `agent_id`              | experimental |
| `AiSubagentTurn` | `agent_type`            | experimental |
| `AiSubagentTurn` | `parent_session_id`     | experimental |
| `AiSubagentTurn` | `workflow_run_id`       | experimental |
| `AiSubagentTurn` | `model`                 | experimental |
| `AiSubagentTurn` | `input_tokens`          | experimental |
| `AiSubagentTurn` | `output_tokens`         | experimental |
| `AiSubagentTurn` | `cache_read_tokens`     | experimental |
| `AiSubagentTurn` | `cache_creation_tokens` | experimental |
| `AiSubagentTurn` | `usd`                   | experimental |
| `AiSubagentTurn` | `team_id`               | stable       |
| `AiSubagentTurn` | `project_id`            | stable       |
| `AiSubagentTurn` | `org_id`                | stable       |
| `AiWorkflowRun`  | `run_source`            | experimental |
| `AiWorkflowRun`  | `workflow_run_id`       | experimental |
| `AiWorkflowRun`  | `subagent_type`         | experimental |
| `AiWorkflowRun`  | `agent_model`           | experimental |
| `AiWorkflowRun`  | `duration_ms`           | experimental |
| `AiWorkflowRun`  | `run_in_background`     | experimental |
| `AiWorkflowRun`  | `session_id`            | experimental |
| `AiWorkflowRun`  | `team_id`               | stable       |
| `AiWorkflowRun`  | `project_id`            | stable       |
| `AiWorkflowRun`  | `org_id`                | stable       |

## Stable attributes bump the schema version, and experimental ones do not

- A rename, removal, or change of meaning on a stable attribute bumps the schema version at the top of this page. Its changeset names the break.
- An experimental attribute can change or disappear under a `minor` changeset, with no bump to the schema version. The changeset names the change.
- A new attribute, or an experimental attribute promoted to stable, does not bump the schema version.

The [Schema Versioning](./METRICS_TABLE.md#schema-versioning) rule for `event_version` still applies to stable attributes.
