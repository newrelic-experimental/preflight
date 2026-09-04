---
title: What's New
description: The changes worth knowing about, batched by what they mean for you rather than by version number.
---

<!--
Editions, newest first. One edition covers a run of releases and is written for
someone who uses Preflight but does not follow the repo. Lead with anything the
reader has to do after upgrading. The landing page shows the first H2 as its
announcement pill, so keep it short. Run `npm run whats-new:draft` to list the
changelog entries newer than the last edition. Per-version detail stays in
CHANGELOG.md.
-->

## Plugin install and truer cost numbers

Covers 1.18.3 through 1.33.1, released August 30 to September 3, 2026.

**Two things to do after upgrading.** Run `preflight install` once more so the two new permission hooks get registered; `preflight doctor` will flag this until you do. If your config has New Relic credentials, it now needs an explicit `mode` line (`local`, `cloud`, or `both`) and will refuse to start without one. That is deliberate: Preflight no longer sends telemetry anywhere just because a license key happens to be present.

**Install without npm.** Claude Code users can add Preflight as a plugin: `/plugin marketplace add newrelic-experimental/preflight`, then `/plugin install newrelic-preflight@newrelic-preflight-marketplace`. No separate install or build step. Preflight is also listed in the official MCP Registry, so any client that browses the registry can find it.

**Your numbers got more honest.** Tool latency no longer includes the time you spent staring at a permission prompt. Turn and task boundaries come from Claude Code's own prompt-submit and stop signals instead of guessing from idle gaps. A cost spike after resuming an old session now carries Claude Code's own explanation of the cache re-warm instead of showing up as a mystery dip. Model switches are recorded as events, including automatic fallbacks. Teams billed at a negotiated rate can set a discount multiplier so every dollar figure matches the invoice. Pricing now covers Grok 4.6, Gemini 3.8 Flash, and Claude Fable and Mythos 5.1, and a Bedrock Haiku cache bug that priced cached tokens at zero is fixed.

**Sessions are labeled correctly.** Some Claude Code sessions were filed under a generic MCP label because detection checked environment variables Claude Code never sets. The GitHub Copilot desktop app is now recognized as its own platform with exact token costs read from its local usage database. Copilot sessions drained through `--local` reach New Relic and keep their real platform tag.

**For teams on New Relic.** A `companionMode` setting stops cost from being counted twice when Claude Code's built-in OTel export is also on. Commits, pushes, force-pushes, and PR outcomes now arrive as `ai.git.*` metrics with the same developer and team attribution as cost. Every event carries an `event_version` so dashboards can branch on schema changes. The OTLP receiver enriches protobuf payloads, not just JSON. A new `preflight server` mode collects events from several machines onto one box, with a shared dashboard still to come.

**Smaller fixes.** `git push --force-with-lease` is no longer flagged as a destructive command. Chart tooltips are readable in dark mode again. The Compute Waste card now names the session responsible for retry thrashing.
