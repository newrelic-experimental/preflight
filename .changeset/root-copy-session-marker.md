---
'@newrelic/preflight': patch
---

**A server no longer adopts another assistant's ended session from a shared directory.** When two Claude Code sessions shared a directory and the first had exited, a Kiro server starting in that directory could adopt the ended session from the copy of its breadcrumb kept for older servers. The hook collector now also records each session it files under its assistant, and a server skips any old-layout copy whose session an assistant recorded. Breadcrumbs from a 1.73.0 or earlier collector record nothing, so they still count as before. The record is touched on every hook and cleaned up after 7 idle days, like the per-directory breadcrumbs.
