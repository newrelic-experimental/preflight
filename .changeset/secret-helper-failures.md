---
'@newrelic/preflight': patch
---

**A failing secret helper could stop the dashboard or send the digest to the wrong webhook.** Four cases are fixed.

- When `licenseKeyCommand` fails, the `--local` dashboard falls back to local mode, as it does for a missing license key, instead of exiting. This matters when nobody is there to answer the helper's Keychain or 1Password prompt, such as after an automatic update. The startup warning and `/api/health` hint say the helper failed rather than that the key is missing.
- When `digestWebhookUrlCommand` fails, the digest is not sent to a plaintext `digestWebhookUrl` left in the config file. The command outranks the file, so the file's URL is never a fallback.
- `nr_observe_subscribe_digest` now refuses to save a webhook URL while `digestWebhookUrlCommand` is set, since the command would outrank it, and `nr_observe_send_digest` says the command supplied no URL instead of asking you to subscribe again.
- A blank `NEW_RELIC_AI_DIGEST_WEBHOOK_URL`, `NEW_RELIC_LICENSE_KEY`, or `NEW_RELIC_API_KEY` is now treated as unset, so it no longer hides a configured `*Command` or the value in the config file.
