---
'@newrelic/preflight': patch
---

A tool call whose start and finish two Preflight processes picked up now counts once in the saved session's tool call and Bash counts instead of twice. This happened when an engine restarted while the old one still ran, or when a dashboard server or a second engine drained hook events next to a session's engine. Tests run, builds and lines added still count such a call twice. The fix matches calls by tool use id within a session. A call from a platform that sends no id can still count twice when its finish cannot take the id minted at its start: a finish with no start, or one more than 40 minutes after it.
