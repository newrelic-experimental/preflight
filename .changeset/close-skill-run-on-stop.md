---
'@newrelic/preflight': patch
---

**A skill run no longer absorbs the rest of the session on installs that send no prompt events.** A skill run closed only on the next prompt or the next skill, so a hook install without `UserPromptSubmit` kept one run open for every later tool call and charged it the session's remaining cost. The run now also closes when the turn ends on the `Stop` hook.
