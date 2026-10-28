<div align="center">
  <img src="assets/preflight-logo.svg" alt="Preflight" width="96" height="96" />
  <h1>Preflight — Kiro Power</h1>
  <p><strong>AI coding observability for Kiro</strong></p>
</div>

---

Preflight observes your Kiro coding sessions — every tool call, what it cost,
and patterns like thrashing, redundant re-reads or stuck loops — and exposes the
results as `nr_observe_*` MCP tools the agent can query.

**Local-first.** A dashboard at `http://127.0.0.1:7777`, no account required,
nothing leaves your machine. Connect a New Relic account only when you want
team rollups, alerting and cross-session history.

## Install

1. In Kiro, open the **Powers** panel
2. Find **Preflight** under **Available** powers and install it
3. Click **Try power**, then ask the agent to set up Preflight

The agent will use the [`setup` skill](skills/setup/SKILL.md) and walk through
the rest.

> **Not listed yet, or want to run an unreleased version?** You can also install
> it directly: **Powers** panel → **Add Custom Power** → **Import power from
> GitHub** and give it this repository's URL. The same panel's **Import power
> from a folder** works against a local clone, which is the quicker loop when
> you're changing the power's own files.

## What you get, and what needs one more step

|                       |                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **MCP tools**         | Automatic. `mcp.json` fetches the package on demand via `npx` — no prior install needed. |
| **Tool-call capture** | One-time manual step. Needs a global collector binary plus a workspace hook file.        |

A Kiro Power cannot ship hooks or executables, so capture can't be automated by
the power itself. Without it the install still _looks_ healthy —
`nr_observe_health` succeeds — while most of the session goes unobserved. The
`setup` skill covers it.

## Contents

| Path                                         | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `plugin.json`                                | Agent Plugins manifest                                              |
| `mcp.json`                                   | MCP server declaration                                              |
| `skills/setup/SKILL.md`                      | First-run setup: dependencies, hook wiring, local vs. cloud mode    |
| `skills/setup/references/troubleshooting.md` | Session-id resolution, hook exit codes, platform attribution        |
| `skills/setup/scripts/validate-deps.sh`      | Checks that `preflight` and `preflight-collector` resolve on `PATH` |
| `skills/observability/SKILL.md`              | The `nr_observe_*` tool catalog and when to use each tool           |
| `assets/`                                    | Logo                                                                |

This power uses the Agent Plugins format: a `plugin.json` manifest, an
`mcp.json` server declaration, and `skills/`.

## Requirements

- **Kiro** with the Powers panel
- **Node.js 22+** — `npx` fetches the MCP server on demand
- **`npm install -g @newrelic/preflight`** — only for tool-call capture, since
  the hook binary runs on every tool call and can't be routed through `npx`
- **A New Relic account** — optional, only for cloud mode

## Privacy

Local mode is the default and sends nothing off the machine — sessions are
written to `~/.newrelic-preflight/` and served on `127.0.0.1`. Cloud mode
transmits telemetry to New Relic only after you supply a license key and
explicitly switch modes. Tool-call _content_ is not recorded unless you opt in,
and secrets are redacted before anything is written or sent.

See the [New Relic Privacy Notice](https://newrelic.com/termsandconditions/privacy)
for how New Relic handles data you choose to send.

## Support

- **Issues and questions:** [github.com/newrelic-experimental/preflight/issues](https://github.com/newrelic-experimental/preflight/issues)
- **Project:** [github.com/newrelic-experimental/preflight](https://github.com/newrelic-experimental/preflight)

## License

Apache-2.0. See the [main repository](https://github.com/newrelic-experimental/preflight)
for details.
