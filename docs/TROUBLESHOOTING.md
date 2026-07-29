---
title: Troubleshooting
description: Common setup and connection problems with Preflight, and how to fix them.
---

# NR AI Coding Observability: Preflight — Troubleshooting

Common setup and connection problems, and how to fix them.

---

## Start here

Before anything else, run:

```bash
preflight doctor
```

It checks your config, hook wiring, daemon status, storage permissions, and New Relic connectivity, and prints a fix command next to anything that's broken. Most setup problems are one of these checks failing.

---

## MCP server won't start (wrong Node version)

**Symptom:** Preflight is installed and `~/.mcp.json` looks correct, but the MCP connection fails — most commonly reported from **Claude Code for VS Code**, where the extension host doesn't always resolve `node` the same way your terminal does.

**Cause:** Preflight requires **Node.js v22 or higher** (see [Requirements](../README.md#requirements)). If you installed Node via [nvm](https://github.com/nvm-sh/nvm) and the MCP client launches `node` from `PATH` rather than from a login shell, it can resolve to a stale nvm-installed version instead of your intended default — even after running `nvm alias default <version>`, since that only changes what a _new shell_ resolves to, not what a GUI process already has cached or resolves via a different mechanism.

**Fix:** Point `~/.mcp.json` directly at the Node binary and Preflight script you want to run, instead of relying on `PATH` resolution:

```json
{
  "mcpServers": {
    "newrelic-preflight": {
      "command": "/absolute/path/to/.nvm/versions/node/vX.Y.Z/bin/node",
      "args": [
        "/absolute/path/to/.nvm/versions/node/vX.Y.Z/lib/node_modules/@newrelic/preflight/dist/index.js",
        "--stdio"
      ]
    }
  }
}
```

Find your actual paths with:

```bash
nvm which <version>                          # -> the node binary path
npm root -g                                  # -> the global node_modules path (for the args entry)
```

Restart your AI tool after editing the config.

---

## Claude Desktop shows no session data

**Symptom:** Preflight is configured as an MCP server for the Claude Desktop app, but the dashboard never shows any activity from it.

**Cause:** This is expected — **Claude Desktop is not a supported platform for automatic observability.** Preflight's automatic capture relies on a hook/callback mechanism (`PreToolUse`/`PostToolUse`) that fires on every built-in tool call. Claude Desktop can load Preflight as an MCP server, but it has no such hook mechanism — see [ADAPTERS.md](./ADAPTERS.md) for how visibility tiers work across platforms. Without hooks, none of Desktop's built-in tool calls are ever reported to Preflight, so there's nothing for the dashboard to show.

**Fix:** none — this is a platform limitation, not a bug. Use one of the platforms listed under [Works With](../README.md#works-with) (Claude Code, Cursor, Windsurf, GitHub Copilot, Zed, Continue.dev, Amazon Q Developer, Amazon Kiro) for automatic capture.

---

## Still stuck?

Open an issue: [github.com/newrelic-experimental/preflight/issues](https://github.com/newrelic-experimental/preflight/issues)
