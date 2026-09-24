# Preflight verification map

This directory is the maintained source for verifying Preflight's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build this checkout with `npm ci && npm run build`.
- Set `PF=.claude/skills/verify-preflight/scripts/pf-verify` from the repo root.
- Start a dashboard with `$PF up` on the default port 7791, or use `PF_PORT=<port>`.
- Run `$PF doctor` and require four `ok` lines before any drive.
- Mint every session id with `SID=$($PF sid)`. Only UUID ids carry transcript cost.
- Never drive port 7777, `~/.newrelic-preflight`, or `~/.claude/projects`. They belong to the developer's live install.

## Driving conventions

- Feed input only through `$PF hook` (Claude Code hook stdin) and `$PF turn` (Claude Code transcript lines). They are the two inputs a real session produces.
- Read results through `$PF api`, `$PF shot`, and `$PF mcp`. Those are the three surfaces a user touches.
- In the browser, locate elements by the page `h1`, KPI labels, `aria-label`s, and visible session names. Never use coordinates or DOM position.
- Wait at least 5s after the last input before reading. The buffer drains every 100ms, the transcript watcher polls every 2s, and sessions persist every 3s under the helper.
- Run MCP proofs on their own `PF_PORT` with no `up` server.

## Proof and skip reporting

- Every proof pairs the input command with the resulting API body, MCP output, or `shot` PNG and text.
- A `shot` proof passes only when every `--expect` line prints `ok`.
- Persistence proof lists `<run>/store/sessions/*_<sid>.json`.
- Record the feature ID and entry point with every artifact name, for example `shot / today-kpis`.
- Report an unreachable path with the command and the unmet precondition. A connection error while `$PF doctor` shows the process up and owning the port is a host problem. Report it as blocked, not failed.
- Do not report a skipped entry point as verified through a different surface.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with pf-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Hook capture](./hook-capture.md) covers tool calls flowing from Claude Code hooks into a live session, including failures and persistence.
- [Cost and tokens](./cost-and-tokens.md) covers transcript token usage turning into per-model cost.
- [Today view](./today.md) covers the dashboard landing page, its empty state, and its KPIs.
- [Sessions view](./sessions.md) covers the session list, its filters, and selecting a session.
- [MCP tools](./mcp-tools.md) covers the `nr_observe_*` tools an agent calls over stdio.
