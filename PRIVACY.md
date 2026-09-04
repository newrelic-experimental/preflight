# Privacy and Data Collection

This document describes what data this tool collects, what is sent to New Relic when cloud mode is active, and which configuration settings have privacy implications. It does not constitute legal advice. Individuals and organizations should review the information below and take whatever actions are appropriate for their situation before enabling cloud telemetry.

---

## What Is Always Collected (Local Only by Default)

The following is written to `~/.newrelic-preflight/` on the developer's machine regardless of configuration. It does not leave the machine unless cloud mode is enabled (see below).

- Every tool call the AI assistant makes: tool name, duration, success/failure, input byte size, and a short SHA-256 hash of the input.
- File paths accessed by Read, Write, and Edit operations.
- Bash commands executed, after credential-pattern redaction.
- Session-level counts: tool calls, files touched, session duration, token usage (counts only — not message text).
- An audit log of every tool invocation, including flags for sensitive file access (`.env`, `.pem`, SSH keys) and destructive commands.
- A per-developer collaboration profile — behavioral scores (specificity, autonomy, correction rate, task complexity) and a classification label (`"Power User"`, `"Delegator"`, `"Learning"`, or `"Collaborative"`) — computed on demand from local session history. Returned only to your own AI assistant when it calls the `nr_observe_get_collaboration_profile` MCP tool. This is never transmitted to New Relic, in any mode.

Local storage uses restrictive permissions (`0o700` directories, `0o600` files). See [SECURITY.md](./SECURITY.md) for details on file system safety and redaction patterns.

**A note on behavioral classification data:** the collaboration profile above differs from the rest of this list in what it characterizes — rather than recording what the AI assistant did, it's an inferred characterization of how a developer works. It stays local and is never queryable from a New Relic account, but organizations deploying this tool in a workplace context may still want to determine whether internal policy governs locally-computed behavioral characterizations of individual developers, independently of this document's cloud-telemetry guidance below.

---

## What Is Sent to New Relic When Cloud Mode Is Active

When `mode` is `cloud` or `both`, the following is transmitted to New Relic as custom events and metrics. The table below notes the privacy implication of each field — not just what it is, but why it warrants review before enabling.

| Field                       | NR Event / Metric                                                | Privacy note                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer identifier        | All events, `developer` dimension                                | Defaults to the OS username (`$USER`) or `git config user.name`. This is a real person's identifier attached to every event and metric in the account.                                                                                                                                                                                                                                                                       |
| Working directory           | `AiToolCall.cwd`                                                 | An absolute path that typically embeds the OS username (e.g. `/Users/jjang/...`).                                                                                                                                                                                                                                                                                                                                            |
| File paths                  | `AiToolCall.filePath`, `AiAuditEvent.file_path`                  | Absolute paths for every file the AI reads, writes, or edits. May embed usernames and reveal project structure.                                                                                                                                                                                                                                                                                                              |
| Bash commands               | `AiToolCall.command`                                             | Full command string after credential-pattern redaction. May contain hostnames, usernames in arguments, or internal service names.                                                                                                                                                                                                                                                                                            |
| Grep patterns               | `AiToolCall.pattern`                                             | Search terms the AI used in the codebase. Can reveal what the AI was looking for, which may be sensitive.                                                                                                                                                                                                                                                                                                                    |
| Agent descriptions          | `AiToolCall.agentDescription`                                    | Free-text description of spawned sub-agent tasks. User-authored; no content scanning beyond credential redaction.                                                                                                                                                                                                                                                                                                            |
| Workflow agent descriptions | `AiWorkflowRun.agent_description` (agent-tool-sourced runs only) | **Free text, redacted before egress.** The `Agent` tool prompt/description for the spawned agent, passed through the same credential-pattern redaction as `AiToolCall.command`. Redaction only catches known secret formats — same caveat as `recordContent` below. Not present on script-sourced `AiWorkflowRun` events.                                                                                                    |
| Task subjects               | `AiToolCall.taskSubject`                                         | Free-text subject from task creation. User-authored; may contain project names, customer references, or ticket numbers.                                                                                                                                                                                                                                                                                                      |
| Session metrics             | `ai.session.*`                                                   | Per-developer duration, file counts, cost in USD, efficiency scores.                                                                                                                                                                                                                                                                                                                                                         |
| Subagent & workflow metrics | `AiSubagentTurn`, `AiWorkflowRun`, `AiObservabilityHealth`       | Per-turn token counts and cost, workflow run status/duration, and watcher self-health for the workflow/subagent pipeline. No free text beyond `agent_description` above.                                                                                                                                                                                                                                                     |
| Retry-thrashing alerts      | `AiRetryAlert`                                                   | Tool name, occurrence count, and estimated tokens wasted when the same tool call repeats in a short window. No command/pattern/file-path content — just the flagged tool's name.                                                                                                                                                                                                                                             |
| Audit events                | `AiAuditEvent`, `SecurityAlert`                                  | Every classified tool call; security alerts include the triggering file path or command.                                                                                                                                                                                                                                                                                                                                     |
| Repository identifier       | `project_id`                                                     | Inferred from `git remote get-url origin` (e.g. `org/repo`) unless set explicitly. May expose internal repository names.                                                                                                                                                                                                                                                                                                     |
| Repository URL              | `repo_url`                                                       | The full git remote URL (e.g. `https://github.com/org/repo`), inferred from the same `git remote get-url origin` read as `project_id`. More sensitive than `project_id`: it may reveal an internal git host, not just an org/repo pair. Embedded credentials (e.g. `https://user:token@host/...`) are stripped before egress. Sent by default; has its own opt-out (`repoUrlEnabled: false`), independent of `project_id`'s. |

One additional event type, `NrAiObserveSetupCheck`, is sent directly to the Events API during license-key validation. It carries no session, developer, or file data — see [METRICS_TABLE.md → Setup Validation](./docs/METRICS_TABLE.md#setup-validation).

---

## Who Can See This Data in Your New Relic Account

Data sent to New Relic is visible to any user in the target account who has NRQL query access. This includes the `developer` identifier and individual file paths and commands in `AiAuditEvent`.

Before enabling cloud telemetry, review who has access to the account and what query permissions they hold. New Relic's user management documentation is here:

> [docs.newrelic.com → User management](https://docs.newrelic.com/docs/accounts/accounts-billing/new-relic-one-user-management/user-management-ui-and-tasks/)

Take whatever access-control actions are appropriate for your situation.

---

## Privacy-Relevant Configuration Settings

The settings below have direct privacy implications. Each one is documented fully in [README.md](./README.md) (configuration section) and [SECURITY.md](./SECURITY.md) (technical enforcement). This section focuses only on why each setting matters from a privacy standpoint.

### `recordContent` — off by default

By default the tool collects metadata (lengths, hashes, counts) but not the actual text of files, bash output, or agent responses. Enabling `recordContent: true` causes literal file contents, command output, and agent text to be written to the local buffer and, in cloud mode, sent to New Relic. Credential-pattern redaction runs before egress, but it only catches known secret formats — not arbitrary sensitive content in source code or command output.

**Privacy implication:** This is the highest-impact content flag. Do not enable it without understanding what files and commands the AI assistant accesses in your environment.

See [SECURITY.md → Secret Redaction](./SECURITY.md#secret-redaction) for the full list of what credential patterns are caught before egress.

### `highSecurity` — forces content recording off

Setting `highSecurity: true` in the config file overrides `recordContent` to `false` regardless of any other setting. It also clips free-form error message content before it reaches NR events.

**Privacy implication:** Use this in environments where content must never leave the machine, regardless of how other settings are configured.

See [SECURITY.md → High security mode](./SECURITY.md#high-security-mode) for the technical enforcement details. Set it in the config file (`~/.newrelic-preflight/config.json`), not only via environment variable.

### `developer` — defaults to OS username

The `developer` field defaults to the operating system username or git author name. It is attached as a dimension to every NR event and metric.

**Privacy implication:** This sends a real person's identifier to a shared NR account where other users can query it. Consider setting it explicitly to a pseudonym or role-based identifier, especially in shared or managed environments.

See [README.md → Key settings](./README.md#key-settings) for how to override it.

### `projectId` — inferred from git remote

By default the tool runs `git remote get-url origin` and extracts `org/repo`. This value appears on all NR events.

**Privacy implication:** Internal repository names may be confidential. If the inferred value would expose a private or sensitive repo name, set `projectId: null` to disable inference, or set it explicitly to a sanitized value.

See [README.md → Key settings](./README.md#key-settings) for configuration.

### `repoUrl` — inferred from the same git remote as `projectId`

By default the tool also sends the full git remote URL as `repo_url`, derived from the same `git remote get-url origin` read used for `projectId`. Any embedded credentials in the URL are stripped before the value is sent. Override the value with the `NEW_RELIC_AI_REPO_URL` environment variable or the `repoUrl` key in `~/.newrelic-preflight/config.json`.

**Privacy implication:** A full remote URL can reveal more than an `org/repo` pair alone, for example an internal git hostname. It has its own opt-out, independent of `projectId`'s: set `repoUrlEnabled: false` in `~/.newrelic-preflight/config.json`, or `NEW_RELIC_AI_REPO_URL_ENABLED=false`, to stop sending it while still sending `project_id`. The `preflight install` setup wizard prompts for this explicitly, so sending it is an informed choice rather than a silent default.

### `mode: 'local'` — no data leaves the machine

Local mode disables all cloud transport entirely. The local dashboard and analytics still work.

**Privacy implication:** This is the appropriate starting point for evaluating the tool before deciding whether cloud telemetry is suitable for your environment or organization.

See [README.md → Local mode](./README.md#local-mode) for the full local-mode setup.

---

## Data Retention in New Relic

Data sent to New Relic is subject to your account's retention settings. New Relic's documentation on managing data retention:

> [docs.newrelic.com → Data retention](https://docs.newrelic.com/docs/data-apis/manage-data/manage-data-retention/)

Relevant event types emitted by this tool: `AiToolCall`, `AiMcpToolCall`, `AiProxyRequest`, `AiAuditEvent`, `SecurityAlert`, `AiCodingTask`, `AiAntiPattern`, `AiBudgetWarning`, `AiContextSnapshot`, `AiSubagentTurn`, `AiWorkflowRun`, `AiObservabilityHealth`, `AiRetryAlert`. Full per-field detail for every event type: [METRICS_TABLE.md](./docs/METRICS_TABLE.md).

Local data retention is controlled by `retainSessionsDays` in the config file. See [README.md → Key settings](./README.md#key-settings).

---

## NR Account Region

Data routes to New Relic's US region by default. A license key beginning with `eu01` routes to the EU region automatically, and a `jp`-prefixed key routes to the Japan region. This can also be set explicitly via `collectorHost`.

See [README.md → Key settings](./README.md#key-settings) for configuration. New Relic's regional data center documentation:

> [docs.newrelic.com → EU region datacenter](https://docs.newrelic.com/docs/using-new-relic/welcome-new-relic/get-started/our-eu-us-region-data-centers/)

---

## Checklist Before Enabling Cloud Telemetry

- [ ] Reviewed the data inventory table above and understand which fields will appear in New Relic.
- [ ] Checked who has access to the target NR account and what NRQL query permissions they hold.
- [ ] Decided whether the auto-inferred `developer` value (OS username) is appropriate, or set it explicitly.
- [ ] Decided whether `projectId` auto-inference (from git remote) is appropriate, or set it to `null`.
- [ ] Decided whether `repoUrl` — more sensitive than `projectId`, may reveal an internal git host — should be sent, or set `repoUrlEnabled: false`.
- [ ] Confirmed `recordContent` is `false` (the default) or, if enabling it, reviewed what content will be captured and what is and is not redacted.
- [ ] If enabling `highSecurity`, set it in the config file.
- [ ] Reviewed the NR account's data retention settings for the event types this tool emits.
- [ ] Confirmed the NR account region matches where data should be stored (`eu01` prefix for EU, or set `collectorHost` explicitly).
- [ ] Shared this document with anyone in your organization whose review is needed before the tool is deployed.
