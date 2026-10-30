---
'@newrelic/preflight': patch
---

**The `--stdio` server answers `initialize` sooner when today's history includes work outside a git repository.** At startup Preflight replays today's earlier sessions and looks up the git repository of each tool call's working directory. A directory outside any repository, such as your home directory, was looked up again for every tool call, each time in a new `git` process. On Windows, where each `git` process takes about 150 ms, this could push startup past the MCP client's connect timeout. A failed lookup is now remembered for 3 seconds, which is enough to collapse that burst into one `git` process while still noticing a `git init` or first commit soon after. A successful lookup is still remembered for 30 seconds. On Windows, different spellings of the same path (`C:\repo`, `c:\repo`, `C:/repo/`) now share one lookup.
