# NR AI Coding Observability: Preflight — Advanced Configuration

Power-user features: OTLP export, proxy mode, local alerts, per-developer alerts, session backfill, and Terraform deployment.

---

## OTLP Transport

By default, Preflight sends telemetry to New Relic's proprietary Events API and Metrics API. You can optionally export to **any OpenTelemetry-compatible backend** — Datadog, Grafana Cloud, Honeycomb, a self-hosted OpenTelemetry Collector, or New Relic's OTLP endpoint — without losing the NR path.

Add these settings to `~/.newrelic-preflight/config.json`:

```json
{
  "otlpEndpoint": "https://otlp.nr-data.net",
  "otlpHeaders": { "api-key": "YOUR_LICENSE_KEY" },
  "transport": "both"
}
```

Or via environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net
export OTEL_EXPORTER_OTLP_HEADERS="api-key=your-license-key"   # comma-separated key=value pairs
export NEW_RELIC_AI_TRANSPORT=both
```

| Setting        | What it does                          | Options                                                                                                                                             |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otlpEndpoint` | OTLP/HTTP endpoint URL                | **New Relic US:** `https://otlp.nr-data.net` · **NR EU:** `https://otlp.eu01.nr-data.net` · Or any backend's OTLP URL (Datadog, Grafana, Honeycomb) |
| `otlpHeaders`  | Extra HTTP headers for authentication | **New Relic:** `{ "api-key": "YOUR_LICENSE_KEY" }` · **Datadog:** `{ "dd-api-key": "YOUR_DATADOG_API_KEY" }`                                        |
| `transport`    | How to send telemetry                 | `"nr-events-api"` (default, NR only) · `"otlp"` (OTLP only) · `"both"` (simultaneous export to NR and OTLP)                                         |

| Transport mode  | Events                           | Metrics                          |
| --------------- | -------------------------------- | -------------------------------- |
| `nr-events-api` | NR Events API                    | NR Metric API                    |
| `otlp`          | OTLP/HTTP (as log records)       | OTLP/HTTP (as gauge data points) |
| `both`          | Both simultaneously (concurrent) | Both simultaneously (concurrent) |

---

## Inbound OTLP Receiver (Proxy Mode)

When running in proxy mode, you can also enable an **inbound OTLP receiver** that acts as a local OpenTelemetry Collector. Any OTel-instrumented app pointing at `http://localhost:4318` will have its telemetry enriched with the current coding session context (`ai.session.id`, `ai.developer`, `ai.project_id`) and forwarded to NR, linking application traces to the AI session that produced them.

Add to `~/.newrelic-preflight/config.json`:

```json
{
  "otlpReceiverEnabled": true,
  "otlpReceiverPort": 4318,
  "otlpForwardEndpoint": "https://otlp.nr-data.net",
  "otlpForwardHeaders": { "api-key": "YOUR_LICENSE_KEY" }
}
```

Or via environment variables:

```bash
export NR_AI_OTLP_RECEIVER_ENABLED=true
export NR_AI_OTLP_RECEIVER_PORT=4318
export NR_AI_OTLP_FORWARD_ENDPOINT=https://otlp.nr-data.net
export NR_AI_OTLP_FORWARD_HEADERS="api-key=your-license-key"
```

| Setting               | What it does                                                                     | Default                                               |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `otlpReceiverEnabled` | Enable the local OTLP/HTTP receiver                                              | `false`                                               |
| `otlpReceiverPort`    | Port the receiver listens on                                                     | `4318`                                                |
| `otlpForwardEndpoint` | Where enriched payloads are forwarded. Set to `null` to receive and enrich only. | `https://otlp.nr-data.net` (when `licenseKey` is set) |
| `otlpForwardHeaders`  | HTTP headers added to every forwarded request                                    | `{ "api-key": <licenseKey> }`                         |

Point your application's OTel SDK at `http://localhost:4318`. JSON OTLP payloads are enriched; protobuf payloads are forwarded as-is.

---

## Setup Wizard — Environment Variable Pre-Fill

If `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_ACCOUNT_ID`, or `NEW_RELIC_API_KEY` are set in the environment when `preflight setup` is run, the wizard pre-fills those prompts and shows the env var name as the hint (`$NEW_RELIC_LICENSE_KEY`). Pressing Enter accepts the value — no copy-paste needed. This makes the wizard scriptable in CI pipelines or Docker-based dev environments where credentials are already injected as environment variables.

---

## Local Alerts

Local-mode users get threshold alerting evaluated in-process, with no New Relic dependency. The engine reads rules from `~/.newrelic-preflight/alerts/rules.json`, evaluates them on a fixed cadence (default 30s), and surfaces firing/clearing events through the embedded dashboard.

**Setting up rules.** The `preflight setup` wizard offers to copy a starter rule set from `examples/local-alert-rules.json` into place when you choose local or both mode. Re-running setup never overwrites a user-edited rules file.

**Eight rule types:**

| Type                                                | What it checks                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cost.window`                                       | Cumulative spend in the named period (`session` / `today` / `week`) crosses a USD threshold. |
| `efficiency.below`                                  | Efficiency score has stayed under N for `windowSeconds` continuously.                        |
| `antipattern.count`                                 | More than N anti-patterns of a chosen type (or any type) in `windowSeconds`.                 |
| `latency.percentile`                                | p50/p95/p99 latency for a tool exceeds N ms.                                                 |
| `budget.session` / `budget.daily` / `budget.weekly` | Budget threshold reached for the named period (uses configured budget caps).                 |
| `tool.failure`                                      | Failure rate for a tool exceeds N% in `windowSeconds`.                                       |

**Channels.** Each rule has a `channels` array — `["banner"]` (default) shows a dismissible banner in the dashboard; `["banner", "os"]` also fires a native OS notification (macOS/Linux/Windows) when `alerts.osNotifications` is enabled in config. `[]` is silent (logged only).

**Alert log.** Every fire/clear is appended to `~/.newrelic-preflight/alerts/log.jsonl` (rotated at the configured retention size). The dashboard's "Recent alerts" panel reads this file.

**Live reload.** Editing `rules.json` reloads the rule set within ~200ms — no server restart needed. One malformed rule is logged and skipped; the rest keeps evaluating.

**Configuration knobs** (under `alerts` in the config file or via env vars):

| Field                              | Env var                         | Default                                   |
| ---------------------------------- | ------------------------------- | ----------------------------------------- |
| `alerts.enabled`                   | `NR_AI_ALERTS_ENABLED`          | `true` outside cloud-only mode            |
| `alerts.evaluationIntervalSeconds` | `NR_AI_ALERTS_INTERVAL_SECONDS` | `30` (5–300)                              |
| `alerts.osNotifications`           | `NR_AI_ALERTS_OS_NOTIFICATIONS` | `false`                                   |
| `alerts.logRetentionMb`            | `NR_AI_ALERTS_LOG_RETENTION_MB` | `10` (1–1024)                             |
| `alerts.rulesPath`                 | `NR_AI_ALERTS_RULES_PATH`       | `~/.newrelic-preflight/alerts/rules.json` |

---

## Per-Developer Alerts

To deploy alert conditions scoped to a single developer identity — with separate thresholds and a personal policy distinct from the team one:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  preflight deploy-alerts --developer <your-name>
```

This creates a separate policy `AI Coding — Personal — <name>` from the JSON files in `alerts/conditions-personal/`, with `developer = '<name>'` injected into every NRQL query. Running without `--developer` deploys only the team policy; running with it deploys only the personal policy.

To remove just the personal policy:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  preflight deploy-alerts --teardown --developer <your-name>
```

### Override personal thresholds

Add an `alerts.personal` block to `~/.newrelic-preflight/config.json`:

```json
{
  "alerts": {
    "personal": {
      "dailyCostUsd": 3,
      "sessionCostUsd": 0.75,
      "efficiencyScoreMin": 35,
      "stuckLoopCountMax": 3
    }
  }
}
```

| Field                | Default | What it controls                                           |
| -------------------- | ------- | ---------------------------------------------------------- |
| `dailyCostUsd`       | `2`     | Daily cost alert threshold (USD)                           |
| `sessionCostUsd`     | `0.50`  | Per-session cost alert threshold (USD)                     |
| `efficiencyScoreMin` | `40`    | Alert when efficiency score stays below this for a session |
| `stuckLoopCountMax`  | `2`     | Alert when stuck loop count exceeds this per session       |

---

## Backfilling Session History

If you have existing NR telemetry but no local session files — for example, because you updated from a version that didn't persist sessions at shutdown — run the backfill script to seed your local history. This is required for `nr_observe_get_personal_insights` and the weekly summary tools to have data.

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npm run backfill:sessions -- \
  --developer <your-name> [--days 90] [--dry-run]
```

The script queries NR for your past sessions, reconstructs session summaries, writes them to `~/.newrelic-preflight/sessions/`, and regenerates weekly summaries. Sessions already present locally are skipped. Run `--dry-run` first to preview what would be written.

| Flag          | What it does                                        |
| ------------- | --------------------------------------------------- |
| `--developer` | Required. The developer name to query sessions for. |
| `--days`      | How far back to look. Default: 30.                  |
| `--dry-run`   | Preview output without writing any files.           |

---

## Terraform Deployment

A Terraform module in `terraform/` is an IaC alternative to the deploy scripts. It deploys all 7 dashboards via `newrelic_one_dashboard_json` and the full alert policy with all 10 conditions (5 shared + 5 personal). Use it for GitOps workflows or when you want Terraform state tracking.

### Prerequisites

Install [tfenv](https://github.com/tfutils/tfenv), then from the `terraform/` directory run:

```bash
tfenv install   # picks up terraform/.terraform-version (1.15.5)
terraform init
```

### Usage

```bash
cd terraform

TF_VAR_account_id=$NEW_RELIC_ACCOUNT_ID \
TF_VAR_api_key=$NEW_RELIC_API_KEY \
TF_VAR_developer=your-name \
terraform apply
```

`TF_VAR_*` is the standard Terraform way to pass variables from environment without touching the command line or committing credentials. You can also use a `.tfvars` file (gitignored) or `-var` flags.

### Variables

| Variable                        | Required | Default | Description                                                    |
| ------------------------------- | -------- | ------- | -------------------------------------------------------------- |
| `account_id`                    | Yes      | —       | New Relic account ID                                           |
| `api_key`                       | Yes      | —       | User API key (`NRAK-...`)                                      |
| `region`                        | No       | `US`    | `US` or `EU`                                                   |
| `developer`                     | No       | `""`    | Developer name — enables personal alert conditions when set    |
| `personal_daily_cost_usd`       | No       | `10`    | Personal daily cost alert threshold (USD)                      |
| `personal_session_cost_usd`     | No       | `5`     | Personal per-session cost alert threshold (USD)                |
| `personal_efficiency_score_min` | No       | `40`    | Alert when efficiency score drops below this                   |
| `personal_anti_pattern_max`     | No       | `10`    | Alert when anti-pattern count exceeds this per 5-minute window |
| `personal_stuck_loop_max`       | No       | `3`     | Alert when stuck loop count exceeds this per 5-minute window   |

### Teardown

```bash
TF_VAR_account_id=... TF_VAR_api_key=... terraform destroy
```

---

## Improving Your Tool Selection Score

`nr_observe_get_tool_selection_score` reports a 0–1 score based on three penalty categories. Here's what each one means and how to write prompts that avoid triggering them.

### Redundant reads

**Triggered when:** the same file is read 3 or more times in a session without an intervening edit or write to that file.

The first two reads of any file are always free. The penalty only applies from the third read onward when no edit or write to that file occurred between the previous read and the current one.

**How to avoid:** Front-load context in your prompt. Name the specific file and describe the change you want in a single request rather than asking exploratory questions first.

- Instead of: _"What's in cost-tracker.ts? ... What does getMetrics return? ... Now update it."_
- Use: _"In `src/metrics/cost-tracker.ts`, update the `getMetrics()` return type to include..."_

### Repeated failures

**Triggered when:** the same tool fails on consecutive calls (back-to-back failures of the same tool name).

A single failure followed by a success does not count. The streak resets only on a successful call to the same tool — calling a different tool between failures does not reset it.

**How to avoid:** When a tool call fails, provide corrective context in your next prompt rather than letting the AI retry identically.

- Instead of: _(letting the AI retry the same failing command)_
- Use: _"That failed because X isn't installed — use Y instead."_

### Unused large outputs

**Triggered when:** a tool returns 4,000 bytes or more and the output is never acted on. This applies to all tool calls except file-modifying operations (edits, writes, commands). For `Read` calls, the penalty is waived if the same file is subsequently edited or written in the session.

**How to avoid:** Prefer targeted reads over broad ones when you only need to understand something, not change it. Use `grep`/`Bash` for lookups rather than reading entire files.

- Instead of: _"Read `src/metrics/` for background."_
- Use: _"Search for all callers of `getMetrics()` in `src/metrics/`."_

### Score floor

Even with many penalties the score won't drop below 0.3, so the metric is intended to track trends over time, not penalize individual sessions heavily.
