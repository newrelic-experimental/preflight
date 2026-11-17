---
'@newrelic/preflight': patch
---

**Preflight now corrects two session guesses it used to keep for the life of the server.** A server that picked its session from a breadcrumb above its own parent process, such as one an older Preflight version left on a tmux server two sessions share, now switches to its own session as soon as its own hooks write their breadcrumb. On Linux, a server launched through `npx` that guessed its session from the working directory now corrects that guess from its host's breadcrumb, as it already did on macOS. On Linux that breadcrumb can also name a session of the same assistant started from inside the host's session, such as a `claude -p` run from a tool call, so in that rare case the server can switch to it instead.
