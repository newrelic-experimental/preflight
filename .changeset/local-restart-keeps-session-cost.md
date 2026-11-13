---
'@newrelic/preflight': patch
---

After the dashboard server restarts, a session that takes another turn keeps its earlier turns in session cost and Spend Today. Before, those showed only the turns billed after the restart. A `--local` dashboard's daily and weekly budget spend also no longer counts a saved session twice once that session's file joins the spend baseline, so the 80% and 100% warnings no longer fire early.
