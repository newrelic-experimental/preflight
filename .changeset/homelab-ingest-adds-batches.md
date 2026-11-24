---
'@newrelic/preflight': patch
---

**A homelab server no longer drops tool calls that arrive after a session was saved.** The server holds each session's forwarded calls in memory and saves them once the session goes quiet for about three minutes or the server stops. The save took the larger of the saved count and the new one, so a session that went quiet and then resumed, or that spanned a server restart, kept only its earlier total: a batch of 3 calls on a saved session of 12 stayed at 12. The server now adds new calls to the saved count and per-tool breakdown. It saves each call's `toolUseId` in the session's timeline and skips a call its saved timeline already holds, so a resent batch of recent calls is counted once.
