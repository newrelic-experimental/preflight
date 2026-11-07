---
'@newrelic/preflight': patch
---

**A digest sent to an invalid Slack webhook is reported as a failure.** Slack answers a bad or revoked webhook URL with a redirect to a web page, and the send followed it and reported success although nothing was delivered. A redirect is no longer followed. The Alerts page and `nr_observe_send_digest` now report that the webhook URL looks invalid or revoked, without echoing the URL.
