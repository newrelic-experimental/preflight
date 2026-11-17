---
'@newrelic/preflight': patch
---

A tool call whose start and finish two Preflight processes picked up now counts once in the saved session instead of twice. This happened when an engine restarted while the old one still ran, or when a dashboard server or a second engine drained hook events next to a session's engine. The fix matches calls by the tool use id the hook sends, so a call that arrives without one can still count twice.
