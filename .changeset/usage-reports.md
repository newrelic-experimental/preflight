---
'@newrelic/preflight': minor
---

Preflight can now share anonymous usage statistics with the Preflight team at New Relic, if you say yes. Nothing is sent unless you opt in. You can choose in `preflight setup`, in a form your assistant shows when a session starts or at the first Preflight tool call, in a dashboard banner, or with `preflight usage-reports enable` and `disable`. Each place Preflight asks lists what a report holds and links to the field list in PRIVACY.md, and `preflight usage-reports show` or Settings in the dashboard shows exactly what is sent. Usage reports stay off with `highSecurity`, `DO_NOT_TRACK` or in CI.

`preflight setup` has a new look: you choose from menus with the arrow keys, keys you type are masked, and a mistyped value such as a port is caught as you type instead of ending the wizard.
