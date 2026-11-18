---
'@newrelic/preflight': patch
---

**A digest sent to an invalid Slack webhook is reported as a failure.** A webhook URL that redirects (seen with a revoked Slack webhook) is now reported as a failed send. Before, the send followed the redirect and reported success although nothing was delivered. A redirect is no longer followed. The Alerts page and `nr_observe_send_digest` now report that the webhook URL looks invalid or revoked, without echoing the URL.
