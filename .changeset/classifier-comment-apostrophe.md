---
'@newrelic/preflight': patch
---

The Bash classifier no longer misses a destructive command that follows a shell comment containing an apostrophe, or an ANSI-C quoted argument (`$'...'`) with an escaped quote. Before, either could hide the rest of the command, so `rm -rf` after it was not flagged as destructive.
