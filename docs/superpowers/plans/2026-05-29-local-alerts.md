# Local Alerts — Implementation Plan

**Created:** 2026-05-29
**Status:** Planned (post-launch v1.1)
**Branch:** `feat/local-alerts-spec`
**Driver:** local-only mode parity with cloud NRQL alert conditions

## §1 — Why this exists

The June 2026 launch positions local-only mode as the privacy-preserving alternative to cloud telemetry. Cloud users get five NRQL alert conditions out of the box (`alerts/conditions/01-daily-cost-spike.json` … `05-session-cost-budget.json`). Local-only users get **none**. If a local-only developer wants to know when their session cost crosses a threshold, when stuck-loop frequency spikes, or when latency degrades, today's answer is "switch back to cloud" — which undercuts the launch story.

Local alerts close that gap: threshold rules evaluated in-process, surfaced through the embedded dashboard (and optionally an OS notification), with no New Relic dependency.

**Why now (post-launch, not before):** the local-only branch shipped on 2026-05-29 (PR #47). The launch is 2026-06-08. This plan picks up the v1.1+ work that was explicitly deferred in the local-only design spec §6 ("Power features → Local alerts").

## §2 — What's already in place

| Component | What it gives us |
|-----------|------------------|
| `BudgetTracker` | Already calls `onThreshold(BudgetThresholdEvent)` at 50/80/100% per period (session/daily/weekly). Half the cost-rule machinery exists. |
| `AntiPatternDetector.analyze(toolCalls)` | Returns the current `AntiPattern[]` per cycle, typed by `AntiPatternType`. |
| `LatencyTracker.getMetrics()` | Returns `LatencyPercentiles` (p50/p95/p99) per tool, plus an overall snapshot. |
| `CostTracker.getMetrics()` | Returns session/today totals in USD. |
| `LiveEventBus` | Typed pub/sub with replay buffer. Currently emits `tool-call`, `cost-update`, `anti-pattern`, `heartbeat`. Adding an `'alert'` event slots in cleanly. |
| `ConfigLoader` | Already supports file-based config under `~/.nr-ai-observe/config.json`. Rules can live alongside. |

The bones are there. This plan wires them together behind a new `LocalAlertEngine`, and adds UI surface area in the dashboard.

## §3 — Mapping cloud rules → local rules

The five existing cloud conditions translate cleanly:

| Cloud condition (`alerts/conditions/`) | Local rule type | Source |
|----------------------------------------|-----------------|--------|
| `01-daily-cost-spike.json` (sum > $10/hour) | `cost.window` | `CostTracker.getMetrics()` over rolling window |
| `02-low-efficiency-score.json` (avg < 40 for 30 min) | `efficiency.below` | `EfficiencyScorer.getMetrics()` over rolling window |
| `03-stuck-loop-rate.json` (>3 stuck loops in 5 min) | `antipattern.count` (filtered by `type`) | `AntiPatternDetector` analyze cycle |
| `04-anti-pattern-rate.json` (>10 patterns in 10 min) | `antipattern.count` (any type) | `AntiPatternDetector` analyze cycle |
| `05-session-cost-budget.json` (single session > $5) | `budget.session` (already covered by `BudgetTracker`) | `BudgetTracker.onThreshold` |

Plus three rule types that don't exist as cloud conditions but matter for the local experience:

- `latency.percentile` — p95 for a tool exceeds N ms
- `budget.daily` / `budget.weekly` — direct passthrough of `BudgetTracker` thresholds
- `tool.failure` — tool failure rate exceeds N% over rolling window

## §4 — Non-goals for v1.1

Explicitly **not** in this plan; deferred to v1.2+:

- Compound rules (`A AND B`, `A OR B`)
- Rule mutability through the dashboard UI (rules stay file-based — same security posture as the rest of config)
- Rule sharing / templates between developers
- Mobile / push notifications
- Alert escalation (paging, Slack, email)
- Anomaly detection (baseline + deviation) — strictly threshold rules

## §5 — Architecture

### `LocalAlertEngine` (new, `src/alerts/local-alert-engine.ts`)

Single class. Owns the rule set, evaluates rules, emits firing/clearing events. Pure (no I/O) so it's trivially testable.

```ts
export interface LocalAlertEngine {
  loadRules(rules: readonly LocalAlertRule[]): void;
  evaluate(snapshot: AlertSnapshot, now: number): readonly AlertEvent[];
  setOnAlert(callback: (event: AlertEvent) => void): void;
}
```

- `evaluate()` is called on a fixed cadence (default 30 s, configurable). It receives a snapshot of the current metrics from the trackers (no direct tracker references — the engine is decoupled).
- Each rule has its own evaluation function. The engine maintains internal state per rule (last-fired timestamp, current state machine) to support hysteresis and deduplication.
- Firing/clearing both emit `AlertEvent`s. Clearing matters for the dashboard banner UX — banners disappear when conditions resolve.

### Snapshot collector

A tiny adapter (`src/alerts/alert-snapshot-collector.ts`) reads from the relevant trackers and builds the `AlertSnapshot`:

```ts
export interface AlertSnapshot {
  readonly timestamp: number;
  readonly cost: { sessionUsd: number; todayUsd: number; weekUsd: number };
  readonly efficiency: { score: number | null };
  readonly antiPatterns: { type: AntiPatternType; count: number }[];   // count over engine's rolling window
  readonly latency: { tool: string; p95Ms: number }[];
  readonly toolFailures: { tool: string; failurePct: number }[];
}
```

The collector also owns the rolling-window buffers for anti-patterns / failures (the trackers don't track windows themselves).

### Rule schema

Stored as JSON for parity with `alerts/conditions/`:

```json
{
  "id": "session-cost-spike",
  "name": "Session cost spike",
  "type": "cost.window",
  "severity": "warning",
  "enabled": true,
  "windowSeconds": 3600,
  "threshold": 10.0,
  "operator": "above",
  "deduplicateSeconds": 300,
  "description": "Fires when session spend exceeds $10 in any rolling hour."
}
```

`type` is one of: `cost.window` · `efficiency.below` · `antipattern.count` · `latency.percentile` · `budget.session` · `budget.daily` · `budget.weekly` · `tool.failure`. Each rule type defines its own required fields (e.g. `antipattern.count` adds `patternType?: AntiPatternType` for filtering; `latency.percentile` adds `tool?: string` and `percentile: 50 | 95 | 99`).

Rules are validated against a Zod schema at load time. Invalid rules are skipped with a logged warning — one bad rule shouldn't disable the engine.

### Rule storage

Rules live at `~/.nr-ai-observe/alerts/rules.json` (single file, array of rules). A starter set is shipped under `examples/local-alert-rules.json` and copied into place by `nr-ai-observe setup` when local mode is selected.

The engine watches the rules file via `fs.watch` so editing the file reloads rules without restarting the server. Reload is debounced (200 ms) to handle editors that write+rename.

### Alert event log

Every fired/cleared event is appended to `~/.nr-ai-observe/alerts/log.jsonl` (capped at 10 MB with rotation). This is the audit trail equivalent for alerts and powers the dashboard's "recent alerts" panel without needing in-memory state to survive restarts.

### Wiring

```
DashboardServer
  ├─ LiveEventBus
  ├─ LocalAlertEngine ──── snapshot collector ──── trackers
  │      │                                          (read-only)
  │      └── on alert → bus.emit('alert', payload) + appendToLog
```

The engine is constructed in `DashboardServer` only when `mode !== 'cloud'`. In `cloud` mode the engine is not started; cloud users continue to use the NR NRQL conditions.

## §6 — Surfacing alerts

### Channel 1 — In-dashboard banner (default)

The dashboard subscribes to a new `'alert'` event on `LiveEventBus`:

```ts
export interface AlertEvent {
  readonly id: string;              // rule.id
  readonly state: 'firing' | 'cleared';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly description: string;
  readonly value: number;
  readonly threshold: number;
  readonly firedAt: number;
}
```

Added to `LiveEventMap`:

```ts
export type LiveEventMap = {
  // ...existing entries...
  'alert': AlertEvent;
};
```

Dashboard UI changes:

1. **Alert banner stack** at the top of the SPA (above the sidebar header). Shows currently-firing alerts grouped by severity, with a dismiss-X. Dismissing a single alert hides it for this session only — it returns on the next reload while still firing.
2. **"Recent alerts" panel** on the Today view, fed from `/api/alerts/recent` (reads the JSONL log, returns last 50 entries). Each row: time, severity dot, title, value vs threshold.
3. **Sidebar badge** — small numeric badge on the "Today" nav item showing the count of currently-firing alerts.

Severity → tone mapping reuses the existing `StatusIndicator` component:
- `info` → neutral
- `warning` → warn (amber)
- `critical` → bad (red)

### Channel 2 — OS notifications (opt-in, off by default)

Behind a config flag (`alerts.osNotifications: true`), critical alerts trigger a system notification via the platform's native channel:

- **macOS**: `osascript -e 'display notification ...'` (no extra dep)
- **Linux**: `notify-send` if available, no-op otherwise
- **Windows**: PowerShell `New-BurntToastNotification` if module present, else PowerShell balloon tip; falls back to no-op

Implementation lives in `src/alerts/os-notifier.ts`, gated by `process.platform`. We do **not** add `node-notifier` or any native module — keeping the dependency tree clean is more important than perfect cross-platform parity. Failure to notify is logged and ignored, never thrown.

This channel is opt-in because:
- Spam risk: a misconfigured threshold could fire repeatedly
- Privacy: some devs don't want their machine flashing notifications mid-pairing
- Locality: dashboard banners are sufficient for the inner-loop developer

### Channel 3 — None of the above (silent)

A rule can set `"channels": []` in its config to fire silently — only logged to JSONL, used for trend analysis without bothering the user. Useful for low-severity rules that the user reviews weekly rather than reacts to.

Default `"channels"` is `["banner"]`. To enable OS notifications a rule must opt in: `"channels": ["banner", "os"]`.

## §7 — Configuration

New top-level config block (`McpServerConfig.alerts`):

```ts
export interface AlertsConfig {
  readonly enabled: boolean;                        // default: true when mode !== 'cloud'
  readonly evaluationIntervalSeconds: number;       // default: 30
  readonly osNotifications: boolean;                // default: false
  readonly logRetentionMb: number;                  // default: 10
  readonly rulesPath: string | null;                // default: ~/.nr-ai-observe/alerts/rules.json
}
```

Env var counterparts:
- `NR_AI_ALERTS_ENABLED` (boolean)
- `NR_AI_ALERTS_INTERVAL_SECONDS` (number, min 5, max 300)
- `NR_AI_ALERTS_OS_NOTIFICATIONS` (boolean)
- `NR_AI_ALERTS_RULES_PATH` (string)

Backwards compatibility: if `alerts` is missing from the config file, defaults apply (engine on for local/both mode, banner-only, 30 s interval). Existing local-only deployments get alerts automatically on upgrade — no config change required.

## §8 — Phased task breakdown

### Phase 1 — Engine + budget rule (~3 days)

End state: `LocalAlertEngine` exists, evaluates `budget.session/daily/weekly` rules wired to `BudgetTracker.onThreshold`, emits `AlertEvent` to `LiveEventBus`. No UI yet.

| # | Task | Files |
|---|------|-------|
| 1 | Add `'alert'` event type and `AlertEvent` interface to `LiveEventBus`. | `src/dashboard/live-event-bus.ts`, `src/dashboard/live-event-bus.test.ts` |
| 2 | Define rule schema (Zod) and `LocalAlertRule` types. Tests cover valid + 5 invalid cases. | `src/alerts/local-alert-rule.ts`, `src/alerts/local-alert-rule.test.ts` |
| 3 | Implement `LocalAlertEngine` skeleton with `loadRules`, `evaluate`, `setOnAlert`. Empty rule set → no events. | `src/alerts/local-alert-engine.ts`, `src/alerts/local-alert-engine.test.ts` |
| 4 | Implement `budget.*` rule types. Subscribes to `BudgetTracker.setOnThreshold`, translates to `AlertEvent`. | `src/alerts/local-alert-engine.ts` (extension) |
| 5 | Implement JSONL alert log writer with rotation. Unit tests for rotation at threshold. | `src/alerts/alert-log.ts`, `src/alerts/alert-log.test.ts` |
| 6 | Wire engine into `DashboardServer` constructor, gated on `mode !== 'cloud'`. | `src/dashboard/dashboard-server.ts`, `src/dashboard/dashboard-server.test.ts` |
| 7 | Acceptance test: spin up server, push cost over budget threshold via `BudgetTracker`, assert SSE client receives `alert` event with correct payload. | `src/dashboard/dashboard-server.test.ts` |

### Phase 2 — Anti-pattern, latency, cost-window, efficiency, tool-failure rules (~3 days)

End state: all 8 rule types implemented and tested. Rolling-window snapshot collector working.

| # | Task | Files |
|---|------|-------|
| 8 | Implement `AlertSnapshotCollector` with 30-min ring buffers per metric source. | `src/alerts/alert-snapshot-collector.ts`, `.test.ts` |
| 9 | Implement `cost.window` rule. Tests for fire/clear lifecycle. | engine extension |
| 10 | Implement `efficiency.below` rule. Tests for the 30-min sustained-below case. | engine extension |
| 11 | Implement `antipattern.count` rule, including `patternType` filter. Tests for stuck-loop and any-pattern variants. | engine extension |
| 12 | Implement `latency.percentile` rule. Tests with synthetic LatencyPercentiles snapshots. | engine extension |
| 13 | Implement `tool.failure` rule (rolling failure rate per tool). Tests. | engine extension |
| 14 | Implement deduplication — same rule can't re-fire within `deduplicateSeconds`. Tests. | engine extension |
| 15 | Acceptance test: load full starter rule set, drive snapshots through engine, assert correct fire/clear sequence. | `src/alerts/local-alert-engine.test.ts` |

### Phase 3 — Dashboard UI (~2 days)

End state: alerts visible as a banner stack, sidebar badge, and a "Recent alerts" panel on Today.

| # | Task | Files |
|---|------|-------|
| 16 | Add `useLiveAlerts` hook (Zustand slice) tracking firing-alert state, banner-dismissals, and recent log. | `src/web/hooks/useLiveAlerts.ts`, `.test.tsx` |
| 17 | Build `AlertBanner` and `AlertBannerStack` components with severity tones and dismiss-X. Tests for keyboard a11y, dismiss behavior. | `src/web/components/AlertBanner.tsx`, `.test.tsx` |
| 18 | Mount banner stack at the SPA root. Update sidebar to show alert count badge on Today nav. | `src/web/App.tsx`, `src/web/components/Sidebar.tsx` |
| 19 | Add `/api/alerts/recent` route returning last 50 log entries. Tests. | `src/dashboard/api-handler.ts`, `.test.ts` |
| 20 | Build "Recent alerts" panel on Today view, fed from React Query against `/api/alerts/recent`. | `src/web/views/Today.tsx`, `.test.tsx` |

### Phase 4 — OS notifications (opt-in) + docs (~1 day)

End state: critical alerts can trigger native notifications when explicitly enabled. README and ONBOARDING updated.

| # | Task | Files |
|---|------|-------|
| 21 | Implement `OsNotifier` with platform branches (macOS / Linux / Windows). Failures logged, never thrown. | `src/alerts/os-notifier.ts`, `.test.ts` |
| 22 | Wire notifier into engine, gated on `alerts.osNotifications` config + per-rule `channels` array. | `src/alerts/local-alert-engine.ts` |
| 23 | Ship starter `examples/local-alert-rules.json` mirroring the 5 cloud conditions plus 3 local-only rules. | `examples/local-alert-rules.json` |
| 24 | Update `nr-ai-observe setup` to copy starter rules into `~/.nr-ai-observe/alerts/rules.json` when local mode is selected. Test for the copy step. | `src/install/setup-wizard.ts`, `.test.ts` |
| 25 | Doc updates: README "Local alerts" section, ONBOARDING.md notes on rule customization, dashboard screenshots. | `README.md`, `docs/ONBOARDING.md` |
| 26 | End-to-end smoke checklist (manual). | `docs/superpowers/plans/2026-XX-XX-local-alerts-smoke-test.md` (created in Phase 4) |

### Acceptance criteria for the whole feature

- [ ] All 8 rule types fire and clear correctly under unit and integration tests.
- [ ] Banner appears within 30 s of a threshold breach in local mode.
- [ ] Banner disappears when the underlying condition clears.
- [ ] OS notification fires only when explicitly enabled at both config and rule level.
- [ ] Editing `rules.json` reloads rules without restart.
- [ ] One malformed rule does not break the engine; it is logged and skipped.
- [ ] In `cloud` mode the engine is not constructed (privacy-proof: no extra fs.watch handles, no extra timers).
- [ ] `/api/alerts/recent` is reachable in `local` and `both` modes; returns 404 in `cloud`.
- [ ] No new ESLint errors or warnings; tsc clean.
- [ ] Manual smoke checklist walked end-to-end before merge.

### Estimated total: ~9 working days

Phase 1 + 2 are mostly mechanical given the existing tracker APIs. Phase 3 is the riskiest — banner UX needs tasteful judgment calls and accessibility coverage. Phase 4 is small but cross-platform.

## §9 — Other follow-up work (backlog)

These items came out of the local-only-mode design spec §6 ("explicitly out of scope (v1.1+)") but are not part of *this* plan. They're parked here so the next planning session has them in one place. None blocks launch.

| Item | Why it matters | Rough size | Notes |
|------|---------------|------------|-------|
| **Standalone `nr-ai-observe ui` command** | Lets a developer review their dashboard without keeping the MCP server attached to Claude Code. Useful for end-of-day review and demos. | Small (1–2 days) | Reuses `DashboardServer`; just a new CLI subcommand that boots the server in read-only mode against the existing storage tree. |
| **Cross-platform browser auto-open** | Quality-of-life: the dashboard URL is currently surfaced in a stderr log line. Auto-opening on first start would be friendlier. | Trivial (~half day) | Use `open` on macOS, `xdg-open` on Linux, `start` on Windows. Behind a config flag (`dashboard.autoOpen`, default true). |
| **Cross-session search / filter** | Once developers live in the dashboard, finding "that one session where X happened" matters. Currently only chronological. | Medium (3–5 days) | Adds a `/api/sessions/search?q=...` route, search box in Sessions view. Search index probably best built lazily from existing session JSON files. |
| **Comparison view (this week vs last)** | Pairs naturally with the existing weekly summary; gives the developer a delta view without leaving the dashboard. | Small–medium (2–3 days) | New tab on History or a panel inside History. Reuses `WeeklySummaryGenerator` data. |
| **WCAG AA accessibility audit + fixes** | Likely required for an NR Labs asset. Catch-all pass (color contrast on charts, ARIA on interactive elements, keyboard traps). | Medium (3–5 days) | Should run this before the v1.1 release ships, even if local alerts is the headline feature. |
| **Personal coach card "trend over time"** | The current card shows the latest week. A small trend strip showing the last 4 weeks of recommendation tone/sentiment would deepen the narrative. | Small (1–2 days) | Pure SPA addition; data already in weekly summaries. Note: the basic personal coach card is already shipped — this is an enhancement, not the original v1 feature. |
| **Setup wizard "alert rules" branch** | When `mode=local` or `both` is chosen in the wizard, prompt to copy starter rules. (Ties into Phase 4 task #24 above but only partially.) | Small | Probably folded into the local-alerts Phase 4 work. |
| **JSONL alert log → SQLite** | If the alert log gets long, JSONL grep is slow. SQLite would unlock fast filter + aggregation in the "Recent alerts" panel. | Medium (3–4 days) | Defer until the JSONL approach actually feels slow. Premature otherwise. |

## §10 — Explicitly out of scope (not planned)

These were called out as out-of-scope in the local-only-mode design spec §6, and remain out of scope. Listed here so future planners don't quietly re-introduce them by accident — each one fundamentally changes what local-only mode *is*.

**Networking & multi-user (changes the security model):**
- LAN / non-loopback binding
- Authentication (no users, no tokens)
- Multi-user data separation
- Phone / tablet access

**Lifecycle (bigger architectural lifts):**
- Always-on daemon (decoupled from MCP) — not unless we have a clear use case
- Service-based install (launchctl / systemd)

**UX polish (defer until requested):**
- Light theme / theme toggle (Console is dark-only by design)
- Mobile-responsive layouts (local-only is single-machine; phone access is out of scope anyway)
- i18n / localization
- Settings editor in the SPA (config stays file-based — security posture, not UX)

**Power features (defer until v2):**
- PDF / image export of dashboard views
- Inline annotation / notes on sessions
- Compound alert rules (`A AND B`, `A OR B`)
- Anomaly detection alerts (baseline + deviation)
- Alert escalation (paging, Slack, email)
- Mobile push notifications

If any of the above start coming up in user feedback, revisit individually — but don't bundle them into local alerts work.

## §11 — Open questions

- **Should local alerts respect the `audit-only` lens too?** I.e. should a tool call against a sensitive file fire an alert? Not in this plan; AuditTrailManager already records them and the Audit view surfaces them. Adding "alert on sensitive-file access" would conflate audit with alerting. Probably no, but worth a 5-min check during Phase 1.
- **Banner position when there are 5+ firing alerts.** Stack vs collapse-to-count vs scroll? Defer to Phase 3 design.
- **Does the engine evaluate when the dashboard has no SSE clients connected?** Yes — the engine runs server-side regardless of UI presence; the JSONL log captures everything for later review. Banners only appear if a client is connected when the alert fires.
- **What happens to alerts during the rules-file reload window?** The engine swaps rule sets atomically (build new map, swap reference). In-flight evaluations finish on the old rule set; the next evaluation uses the new set. No event loss expected.




