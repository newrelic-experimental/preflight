---
title: Claude Code Plugin
description: Install Preflight as a Claude Code plugin — what it gives you, how it's packaged, and how it differs from the npm/global-install path.
---

# Claude Code Plugin

Preflight can be installed directly as a Claude Code plugin, in addition to
the npm-based install (`npm install -g @newrelic/preflight` + `preflight
setup`) described in the main [README](../README.md). Both paths are valid —
the plugin is an additional distribution channel, not a replacement.

## What you get

- **Hooks** — capture for every hook event
  (tool calls, permissions, API failures, prompts, session lifecycle), same
  as the npm install's hook wiring (`preflight setup` / `preflight
install`). The plugin ships a small, dependency-free, precompiled copy of
  the hook collector (see [Packaging](#packaging) below) rather than relying
  on a globally-installed binary.
- **MCP tools** — all `nr_observe_*` tools (session stats, cost breakdown,
  anti-patterns, recommendations, etc.), run via `npx -y
@newrelic/preflight@<version> --stdio`, where `<version>` is the plugin's
  own, so the hooks and the server always come from the same release. No
  local build required. Fleet admins can hold both on one release; see
  [Pinning the version for managed
  deployments](#pinning-the-version-for-managed-deployments).

## Install

```
/plugin marketplace add newrelic-experimental/preflight
/plugin install newrelic-preflight@newrelic-preflight-marketplace
```

Pick an installation scope when prompted:

- **User** — available in every project (recommended for personal use)
- **Project** — checked into the repo's `.claude/settings.json`, shared with
  the team
- **Local** — `.claude/settings.local.json`, gitignored, personal-only

If the install summary says `Run /reload-plugins to activate.`, run:

```
/reload-plugins
```

Then restart Claude Code — hooks and the MCP server activate at session
start, same as the npm install.

## Cloud mode

Local mode (no New Relic account needed, dashboard at `localhost:7777`) is
the default when the plugin's MCP server sees no license key. To send
telemetry to New Relic, set three environment variables:

| Variable                | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| `NR_AI_MODE`            | `cloud` (or `both` to keep the local dashboard as well) |
| `NEW_RELIC_LICENSE_KEY` | Your New Relic ingest license key                       |
| `NEW_RELIC_ACCOUNT_ID`  | Your numeric New Relic account ID (1 to 12 digits)      |

`NR_AI_MODE` is required. A license key with no explicit mode fails at
startup, because telemetry export is opt-in, and the plugin's tools do not
appear.

Set them in your shell profile or in Claude Code's `env` settings. For a whole
fleet, see [FLEET_DEPLOYMENT.md](./FLEET_DEPLOYMENT.md). This is the
shape an admin puts in `settings.json` or managed settings:

```json
{
  "env": {
    "NR_AI_MODE": "cloud",
    "NEW_RELIC_LICENSE_KEY": "<your-license-key>",
    "NEW_RELIC_ACCOUNT_ID": "1234567"
  }
}
```

See [ADVANCED.md](./ADVANCED.md) for the full field reference.

## Packaging

The repo self-hosts its own marketplace at
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) (repo
root — the marketplace manifest's location is fixed) so this repo can be
installed directly without a separate marketplace repo. That marketplace
lists one plugin whose `source` is `./plugin` — **not** the repo root.

Scoping the plugin to its own [`plugin/`](../plugin/) subdirectory, rather
than pointing `source` at `./`, matters because plugin install/update copies
the entire resolved `source` directory into
`~/.claude/plugins/cache/.../<version>/`. Pointing at the repo root would
copy the whole monorepo — tests, docs, terraform, CI, the full `src/` tree —
into every user's plugin cache. Worse, the repo root also has both
`package.json` and `package-lock.json` for the full monorepo (React, Vite,
Playwright, TypeScript, ESLint...), and Claude Code auto-runs
`npm ci --ignore-scripts` whenever it sees that combination at the plugin
root — installing the entire dev dependency tree for no reason, with a real
risk of hitting the 60-second install timeout. `plugin/` has no
`package.json` at all, so no auto-install triggers, and the copied payload is
just the ~5 files below.

Two structural facts shaped what's actually inside `plugin/`, rather than
simply pointing it at this repo's own `dist/`:

1. `dist/` is gitignored — nothing is pre-built/committed, and (per above)
   marketplace installs don't run `tsc` for you even if it were needed.
2. [`src/hooks/collector-script.ts`](../src/hooks/collector-script.ts) has a
   `<5ms execution budget` design constraint — it runs on every single tool
   call, so routing it through `npx` per invocation (as the MCP server does)
   would add unacceptable latency to every tool use for the whole session.

`plugin/` ships:

- **`plugin/.mcp.json`** — `npx -y @newrelic/preflight@<version> --stdio`,
  with `<version>` the plugin's own. The Claude plugin marketplace only lists
  a plugin whose `npx` launcher names an exact version, so `@latest`, a range,
  or a `${VAR}` substitution would fail its check; the release PR writes this
  pin along with the manifest's `version`. The MCP server only starts once per
  session, so `npx`'s one-time resolution cost is a non-issue;
  [`smithery.yaml`](../smithery.yaml) launches the server the same way for
  Smithery's MCP registry listing, but follows `@latest`.
- **`plugin/.claude-plugin/scripts/collector-script.js`** — an
  [esbuild](https://esbuild.github.io/) bundle of `collector-script.ts` (plus
  its two dependency-free local imports, `redaction-patterns.ts` and
  `record-content-gate.ts` — it has no npm dependencies to begin with),
  committed to the repo. `plugin/hooks/hooks.json` points every hook event
  at this one file via `${CLAUDE_PLUGIN_ROOT}`.
- **`plugin/.claude-plugin/plugin.json`** — the plugin manifest itself, at
  the location required relative to the plugin's own root (`plugin/`, not
  the repo root).
- **`plugin/.claude-plugin/icon.png`** — the plugin's icon in the Claude
  plugin marketplace, a 1024 px render of the Preflight logo
  ([`kiro-power/assets/preflight-logo.svg`](../kiro-power/assets/preflight-logo.svg)).
  The marketplace reads it only the first time the plugin is saved or
  submitted in its developer portal, so replacing the file later doesn't
  change the listing.

Run `npm run build:plugin-hook` to regenerate the bundle after changing
`collector-script.ts` or either of its two imports. `npm run
verify:plugin-hook` rebuilds and diffs against the committed copy, failing if
they've drifted — this runs in `.husky/pre-push` and in
[`release.yml`](../.github/workflows/release.yml) so a stale bundle can't
ship.

> **Note:** the release PR writes the plugin manifest's `version` and the
> `.mcp.json` pin along with `package.json`'s version
> (`npm run version-packages`), so don't bump either by hand. See
> [Changesets](../CONTRIBUTING.md#changesets).

## Pinning the version for managed deployments

By default the plugin tracks this repo's `main` branch, so every release
reaches every plugin user once their marketplace updates. That suits
individuals. A fleet rolled out through MDM and Claude Code [managed
settings](https://code.claude.com/docs/en/plugins/org) usually needs change
control instead: a known-good version, a pilot group, and a rollback that
does not wait for a new release.

Pin the marketplace to a release tag with `source.ref`. Every release is
tagged `v<version>`, and the plugin's `.mcp.json` at that tag launches the
same version of the MCP server, so the one key holds the bundled hook
collector and the server together.

A managed settings file that registers the marketplace, requires the plugin,
and holds it on `2.0.0`:

```json
{
  "extraKnownMarketplaces": {
    "newrelic-preflight-marketplace": {
      "source": {
        "source": "github",
        "repo": "newrelic-experimental/preflight",
        "ref": "v2.0.0"
      },
      "autoUpdate": false
    }
  },
  "enabledPlugins": {
    "newrelic-preflight@newrelic-preflight-marketplace": true
  }
}
```

What each key does:

- **`source.ref`** pins the plugin, and with it the hook collector and the
  MCP server, to a release tag. Omit it to track `main`.
- **`autoUpdate: false`** stops the marketplace refreshing in the background.
  It is optional: a plugin whose manifest sets `version` only moves when that
  string changes, and a `ref` tag never does.

To stage a rollout, deliver a different `ref` to each device group (separate
managed settings files or MDM profiles). To roll back, point `ref` at an
earlier tag.

`ref` holds the server only from plugin 2.0.0 on. Plugin versions 1.61.0
through 1.68.0 launch
`@newrelic/preflight@${NEW_RELIC_AI_PREFLIGHT_VERSION:-latest}`, so with a
`ref` in that range the server follows npm's `latest` unless the managed
settings `env` sets `NEW_RELIC_AI_PREFLIGHT_VERSION` to the same version.
From 2.0.0 on, the plugin ignores that variable. Versions before 1.61.0
always launch `@latest`.

A plugin tracking `main` can update in the minutes between a release merging
and its npm publish. Until npm has that version, the server fails to start
with an npm "No matching version" error in the plugin's MCP server log, and
the next session after the publish starts it normally.
