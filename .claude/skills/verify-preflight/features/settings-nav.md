# Settings and navigation

Settings is the dashboard page at `/settings`, listed under the sidebar's Configure group. It shows a System Health panel, an Identity & Account card with editable developer name and team ID plus read-only install fields, a Cost & Retention card with budget and retention inputs, and an Observability card for the subagent watcher. Saves write `config.json` and report whether a restart is needed. The sidebar, the `g` then `e` shortcut, and the `/settings` URL all reach the same page.

## Sub-features

- `settings-page` shows the `Settings` h1 with the sections `System Health`, `Identity & Account`, `Cost & Retention`, and `Observability`.
- `settings-nav-sidebar` opens the page from the sidebar `Settings` button after a click from `/`.
- `settings-save-budgets` shows `Saved. Restart the server for changes to take effect.` after `Save budgets`.
- `settings-patch-api` persists a valid `PATCH /api/settings` and rejects an invalid one with `validation_failed`.
- `settings-watcher` shows a `Subagent watcher:` line in the Observability card.
- `settings-diagnostics` lists the System Health checks from `/api/diagnostics`.

## How to get to it (user POV)

- Choose `Settings` in the sidebar under Configure, from any other page.
- Press `g` then `e` on any page. `shot` cannot press keys, so this entry point is not drivable here.
- Open `/settings` directly on the dashboard URL that `$PF up` prints.

## Driving it with pf-verify

Preconditions: `$PF up` has run, `$PF doctor` prints four `ok` lines, and `PF_PORT` is unset or names the `up` port. The Settings page needs no hooks. Every PATCH below writes to `<run>/store/config.json` under the run's own `HOME`, never to `~/.newrelic-preflight`.

- **Page loads.** Run `$PF shot /settings settings-page --expect "System Health" --expect "Identity & Account" --expect "Cost & Retention" --expect "Observability"`. All four lines print `ok`.
- **Sidebar navigation.** Run `$PF shot / settings-nav-sidebar --click "Settings" --expect "Identity & Account"`. The click runs first, then the expect prints `ok`.
- **Watcher status.** Run `$PF shot /settings settings-watcher --expect "Subagent watcher:"`. The line prints `ok`.
- **Save budgets.** Run `$PF shot /settings settings-save-budgets --click "Save budgets" --expect "Restart the server"`. The line prints `ok`.
- **Persist a value.** Run `$PF api /api/settings -X PATCH -H 'content-type: application/json' -d '{"dailyBudgetUsd":5}'`. The body is `{"ok":true,"restartRequired":true}`. Then `$PF api /api/settings` contains `"dailyBudgetUsd":5`.
- **Reject invalid input.** Run `$PF api /api/settings -X PATCH -H 'content-type: application/json' -d '{"retainSessionsDays":0}'`. The body is `{"error":"validation_failed","errors":["retainSessionsDays must be integer 1-365 or null"]}`.
- **Diagnostics.** Run `$PF api /api/diagnostics`. The body is an array of `{check,status,detail}` objects. The first checks are `Config valid` and `Telemetry mode`, both `ok`.
- **Reset.** Run `$PF api /api/settings -X PATCH -H 'content-type: application/json' -d '{"dailyBudgetUsd":null}'` so the run store is left clean.
- **Proof.** Keep `settings-page.png`, `settings-nav-sidebar.png`, and `settings-save-budgets.png` with their `.txt` files, plus the PATCH and GET bodies. Skip the `g` then `e` shortcut and the `?` overlay, and report them as not driven rather than verified.

## Gotchas

- `--click "Settings"` and `--expect "Settings"` match the sidebar button first, because the sidebar comes before the page in the DOM. Use the page-only text `Identity & Account` to prove the page itself.
- `shot` clicks and checks text only. It cannot type into inputs, press keys, or open the `?` overlay. Prove edits through `$PF api`.
- The restart banner appears after any successful save, even an empty one. The `restartRequired` field in the PATCH body is the real signal.
- `GET /api/settings` reads editable fields from disk, so a PATCH is visible at once. The running server only applies it after a restart.
- The PATCH body ignores `accountId`, `appName`, `mode`, `storagePath`, `highSecurity`, and `licenseKey`. They come from startup config, and `licenseKey` is returned masked.
- Diagnostics refetch every 60s and observability health every 30s, so a `shot` right after load can show `Checking system…` or `checking…`.
