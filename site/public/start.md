# Set up Preflight

You are a coding agent, and the person you are working with asked you to set up Preflight on this machine. Preflight is an open-source observability tool for AI coding assistants. It records every tool call, its cost, and where a session stalls, keeps everything on the local machine by default, and exposes the results to you through MCP tools and to the person through a local dashboard.

Do the steps below in order. Report what each command printed. Stop at step 5, because only the person can restart their coding tool.

## 1. Check Node.js

```bash
node --version
```

Preflight needs Node.js 22 or newer. If the version is older, stop and tell the person. Do not install Node.js yourself.

## 2. Install the package

```bash
npm install -g @newrelic/preflight
```

If the install fails on permissions, do not use `sudo`. Tell the person and suggest a Node version manager such as nvm or fnm.

## 3. Configure it

Preflight has an interactive wizard, `preflight setup`, but you are probably not running in a terminal that can answer prompts. Use the non-interactive form instead:

```bash
preflight install --mode local
```

This wires the hooks and MCP server into the person's coding tool and writes config to `~/.newrelic-preflight/`. Local mode keeps all data on this machine and needs no account.

Preflight detects which coding tool is present. It supports Claude Code, Cursor, Windsurf, GitHub Copilot, Gemini CLI, Codex, Kiro, Amazon Q, and others. If the command reports that it could not detect a tool, tell the person which tool you are and point them at https://newrelic-experimental.github.io/preflight/adapters/ for the manual steps.

Only if the person has explicitly asked to send data to New Relic, and has given you the credentials, use `--mode cloud` or `--mode both` with `--license-key` and `--account-id`. Never ask for credentials on your own initiative, and never guess them.

## 4. Verify

```bash
preflight doctor
```

Every check should pass. If one fails, paste its output to the person along with the fix it suggests.

## 5. Hand back to the person

Tell them:

- Preflight is installed in local mode.
- They need to restart their coding tool, because hooks and MCP servers load at session start.
- After the restart, the live dashboard is at http://localhost:7777.
- In a new session they can ask you questions like "how much has this session cost?" or "did you get stuck anywhere?", and you will answer from Preflight's MCP tools.

Full documentation: https://newrelic-experimental.github.io/preflight/getting-started/
