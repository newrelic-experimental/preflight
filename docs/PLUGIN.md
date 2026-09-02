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

- **Hooks** — `PreToolUse`/`PostToolUse` capture for every built-in tool call,
  same as the npm install's hook wiring (`preflight setup` / `preflight
install`). The plugin ships a small, dependency-free, precompiled copy of
  the hook collector (see [Packaging](#packaging) below) rather than relying
  on a globally-installed binary.
- **MCP tools** — all `nr_observe_*` tools (session stats, cost breakdown,
  anti-patterns, recommendations, etc.), run via `npx -y
@newrelic/preflight@latest --stdio` — always the latest published version,
  no local build required.

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
telemetry to New Relic, set the same environment variables the npm install's
`preflight install --mode cloud` would configure — e.g.
`NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_AI_ACCOUNT_ID` — in your shell profile
or in Claude Code's own `env` settings. See [ADVANCED.md](./ADVANCED.md) for
the full field reference.

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

- **`plugin/.mcp.json`** — `npx -y @newrelic/preflight@latest --stdio`. The
  MCP server only starts once per session, so `npx`'s one-time resolution
  cost is a non-issue; this mirrors the same pattern already used in
  [`smithery.yaml`](../smithery.yaml) for Smithery's MCP registry listing.
- **`plugin/.claude-plugin/scripts/collector-script.js`** — an
  [esbuild](https://esbuild.github.io/) bundle of `collector-script.ts` (plus
  its two dependency-free local imports, `redaction-patterns.ts` and
  `record-content-gate.ts` — it has no npm dependencies to begin with),
  committed to the repo. `plugin/hooks/hooks.json` points both `PreToolUse`
  and `PostToolUse` at this one file via `${CLAUDE_PLUGIN_ROOT}`.
- **`plugin/.claude-plugin/plugin.json`** — the plugin manifest itself, at
  the location required relative to the plugin's own root (`plugin/`, not
  the repo root).

Run `npm run build:plugin-hook` to regenerate the bundle after changing
`collector-script.ts` or either of its two imports. `npm run
verify:plugin-hook` rebuilds and diffs against the committed copy, failing if
they've drifted — this runs in `.husky/pre-push` and in
[`release.yml`](../.github/workflows/release.yml) so a stale bundle can't
ship.

> **Note:** the plugin manifest's `version` field is not auto-synced from
> `package.json` — bump both together when cutting a release.
