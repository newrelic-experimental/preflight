---
'@newrelic/preflight': patch
---

**Daily and weekly budget spend counted a saved session twice in a `--local` dashboard.** The dashboard's own cost total holds every session it watches, and after a session was saved, the spend baseline added that session's file on top. `/api/budget` read high, and the 80% and 100% warnings could fire early. The baseline now counts each session the dashboard holds as its file stood before the dashboard's spend reached it.
