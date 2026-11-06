---
'@newrelic/preflight': minor
---

Session cost and tokens now count each API call exactly once. Every usage is recorded under the call's own id (the transcript message id, Copilot's response id, the Copilot SDK's call id), and session files store those ids next to their totals. So a token line delivered again after a restart, a resumed or rehydrated session, and the `--local` dashboard and the session's engine both saving the same session can no longer add a call twice. Saving from two processes also no longer drops one of them's share. Byte-size estimates are now replaced by the next real report for the session even when another Preflight process read that report.

`nr_observe_report_tokens` takes a new optional `request_id`, the API response's id. A report whose id the transcript already holds is not counted again. A report without one is ignored when the session is already costed from its transcript, Copilot, or Copilot app usage, since it cannot be told apart from a response already counted. Session files written by earlier versions keep their totals.
