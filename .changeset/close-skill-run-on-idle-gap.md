---
'@newrelic/preflight': patch
---

**A skill run no longer absorbs the rest of the session on installs that send no prompt events.** A skill run closed only on the next prompt or the next skill, so a hook install without `UserPromptSubmit` kept one run open for every later tool call and charged it the session's remaining cost. In a session that has never sent a prompt event, the main agent's run now also closes at its first tool call that starts more than 30 seconds after the session's last call ended, the task detector's idle timeout. A gap over 30 seconds from model thinking ends the run early in those sessions. A subagent's call never ends the gap, since the main agent is waiting on it. Once a session sends a prompt, only the next prompt or skill closes the run. A subagent keeps the run it started under. The closed run's `AiWorkUnit` closes at the gap and ends at the run's last call, not at the next skill.
