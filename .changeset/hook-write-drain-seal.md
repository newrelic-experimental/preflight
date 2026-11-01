---
'@newrelic/preflight': patch
---

**A hook event is no longer lost when it is written while Preflight drains the buffer.** A hook that opened the buffer just before a drain took it, and wrote just after the drain read it, wrote into a file that was already deleted. A drain now marks the end of what it read, and a hook whose line lands after that mark writes it again to the live buffer. In a stress run of four draining processes and one fast writer, dozens to hundreds of 20,000 lines were lost per run before this change, and none after.
