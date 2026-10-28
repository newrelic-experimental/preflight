---
'@newrelic/preflight': patch
---

The dashboard's Slack digest settings now say when `NEW_RELIC_AI_DIGEST_WEBHOOK_URL` or `digestWebhookUrlCommand` is overriding the webhook URL saved in `config.json`, instead of showing the file's URL as if it were the one used. A URL supplied only by env or a command now counts as configured, so "Send test now" works. The overriding value is never shown.
