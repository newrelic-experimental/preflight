---
'@newrelic/preflight': patch
---

**A skill run no longer absorbs the rest of the session on installs that send no prompt events.** A skill run closed only on the next prompt or the next skill, so a hook install without `UserPromptSubmit` kept one run open for every later tool call and charged it the session's remaining cost. In a session that has never sent a prompt event, the main agent's run now also closes once the session goes 30 seconds without a tool call, the same idle gap the task detector uses. A gap over 30 seconds from model thinking or a slow tool ends the run early in those sessions. Once a session sends a prompt, only the next prompt or skill closes the run. A subagent keeps the run it started under.
