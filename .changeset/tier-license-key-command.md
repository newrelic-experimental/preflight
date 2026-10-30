---
'@newrelic/preflight': minor
---

Telemetry tiers can read their New Relic license key from a helper command. Set `licenseKeyCommand` (an argv array) on an `nr` tier's `destination` instead of a plaintext `licenseKey`, so a multi-account setup keeps every key out of `config.json`. A failing command stops startup with an error that names the tier and field but never the command's output.
