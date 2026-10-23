---
title: Fleet Deployment
description: Roll Preflight out to a fleet of Claude Code machines with managed settings and MDM, with no per-user files touched.
---

# Fleet Deployment

This page is for an administrator rolling Preflight out to many machines
running Claude Code, through Jamf or another MDM tool or a file-based
configuration manager. It uses Claude Code's
[managed settings](https://code.claude.com/docs/en/managed-settings) to install
the [plugin](./PLUGIN.md) and to hand every machine the same Preflight
configuration. Preflight itself needs no machine-level config file for this.

Nothing under `~/.claude/` or `~/.newrelic-preflight/` is written by your MDM
script. Claude Code applies managed settings above every user and project
setting, so a developer cannot override a key you set.

## What to deploy

One managed settings document does three jobs.

- `extraKnownMarketplaces` registers the Preflight marketplace.
- `enabledPlugins` turns the plugin on.
- `env` hands the plugin's MCP server its configuration.

```json
{
  "extraKnownMarketplaces": {
    "newrelic-preflight-marketplace": {
      "source": {
        "source": "github",
        "repo": "newrelic-experimental/preflight",
        "ref": "v1.67.2"
      },
      "autoUpdate": false
    }
  },
  "enabledPlugins": {
    "newrelic-preflight@newrelic-preflight-marketplace": true
  },
  "env": {
    "NR_AI_MODE": "cloud",
    "NEW_RELIC_LICENSE_KEY": "<your-license-key>",
    "NEW_RELIC_ACCOUNT_ID": "1234567",
    "NEW_RELIC_AI_ORG_ID": "<org-identifier>",
    "NEW_RELIC_AI_TEAM_ID": "<team-identifier>",
    "NEW_RELIC_AI_PREFLIGHT_VERSION": "1.67.2"
  }
}
```

| `env` key                        | Purpose                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NR_AI_MODE`                     | `cloud` or `both`. Required, or a license key stops the server starting.                                                  |
| `NEW_RELIC_LICENSE_KEY`          | Ingest license key for the destination account.                                                                           |
| `NEW_RELIC_ACCOUNT_ID`           | Numeric account ID, 1 to 12 digits.                                                                                       |
| `NEW_RELIC_AI_ORG_ID`            | Organization identifier stamped on every event.                                                                           |
| `NEW_RELIC_AI_TEAM_ID`           | Team identifier stamped on every event.                                                                                   |
| `NEW_RELIC_AI_PREFLIGHT_VERSION` | Holds the MCP server on one npm version. See [PLUGIN.md](./PLUGIN.md#pinning-the-server-version-for-managed-deployments). |

Set `ref` and `NEW_RELIC_AI_PREFLIGHT_VERSION` to the same release so the hook
collector bundled with the plugin and the MCP server stay in lockstep. Omit
`ref` and the plugin tracks `main`, which can carry unreleased changes. Omit
the env var and the server follows npm's `latest` tag. `ref` needs plugin
1.61.0 or later.

The license key sits in a file readable by every local user. Use an ingest
license key scoped to this purpose, never a user API key (`NRAK-…`).

## Where to put it

Claude Code reads one managed source by default and ignores the others, so
pick one mechanism per machine.

| Platform      | Location                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| macOS profile | Configuration profile for the `com.anthropic.claudecode` preferences domain                                    |
| macOS file    | `/Library/Application Support/ClaudeCode/managed-settings.json`                                                |
| Linux and WSL | `/etc/claude-code/managed-settings.json`                                                                       |
| Windows       | `C:\Program Files\ClaudeCode\managed-settings.json`, or the `HKLM\SOFTWARE\Policies\ClaudeCode` registry value |

A profile uses the same top-level keys as the JSON file, with nested objects as
dictionaries. If your organization already manages Claude Code settings, merge
the three keys above into the existing document or profile instead of adding a
second source. A second source would be ignored.

Claude Code's [Deploy managed settings](https://code.claude.com/docs/en/managed-settings)
page covers precedence between sources, and `/status` inside Claude Code shows
which one is in force.

## Who the data belongs to

The plugin's hooks and MCP server run as the user who is logged in, not as the
account your MDM script ran under. `developer` resolves from that user's
`$USER` (or `%USERNAME%` on Windows), lowercased and made safe for NRQL, so each
person is attributed individually without a per-machine setting.

## Prerequisites

- **Node.js 22 or later** on the `PATH` that Claude Code sees. The plugin starts
  its MCP server with `npx`. An app launched from the macOS GUI does not read
  your shell profile, so check the `PATH` of the launching environment rather
  than a terminal.
- **Network access** from each machine to npm (the server is fetched on first
  start) and to your New Relic ingest endpoints.

## Checking a machine

1. Run `/status` in Claude Code and confirm the setting sources line names your
   managed source.
2. Run `claude mcp list`. The Preflight server should show `Connected`.
3. Run `preflight doctor` if the npm package is also installed, or call the
   `nr_observe_health` tool from a session.

If the server shows `Failed to connect`, the most common cause is a license key
with no `NR_AI_MODE`. See [Cloud mode](./PLUGIN.md#cloud-mode) in PLUGIN.md.

## What has been tested

- **Tested.** On Linux with Claude Code 2.1.304 and a `managed-settings.json` in
  `/etc/claude-code/`, values in the managed `env` reach the plugin's MCP
  server. The pin variable expanded into the server command. A license key with
  no mode failed the server, and the same key with `NR_AI_MODE=cloud` connected.
- **Not yet tested.** Delivery as a macOS configuration profile through Jamf.
  Whether the managed `env` reaches hook processes. Whether Claude Code installs
  the plugin without a prompt on first launch, as opposed to an admin running
  `claude plugin install`. Confirm these on one pilot machine before widening
  the rollout.

## What this does not do

Preflight has no machine-level config file an administrator can lock, and no
installer subcommand that writes managed settings. Anything `env` cannot
express, such as a multi-tier `tiers` array, still comes from the user's own
`~/.newrelic-preflight/config.json`. Packaged
installers for hosts without Node.js are tracked separately.
