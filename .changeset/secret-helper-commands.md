---
'@newrelic/preflight': minor
---

Keep your license key, User API key, and Slack digest webhook out of plaintext `config.json`. New `licenseKeyCommand`, `nrApiKeyCommand`, and `digestWebhookUrlCommand` fields take a command (an argv array with an absolute path, such as macOS Keychain's `security find-generic-password ... -w`, 1Password's `op read`, or `vault kv get`) that Preflight runs once at startup to read the secret. Environment variables still win over these fields, and the command wins over a plaintext value. A `licenseKeyCommand` that fails, times out, or prints nothing stops startup with an error that names the field and never shows the command's output; a failing `nrApiKeyCommand` or `digestWebhookUrlCommand` only logs a warning and starts without that secret. `nr_observe_get_config` and `preflight doctor` now report where each secret came from (`env`, `command`, `file`, or `unset`), never the value.

Sending the weekly digest now honors `NEW_RELIC_AI_DIGEST_WEBHOOK_URL`, which it used to ignore in favor of the config file. If you set that variable, digests will now go out to that URL where they previously did not.
