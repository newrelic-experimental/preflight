---
'@newrelic/preflight': patch
---

The Bash classifier no longer misses a destructive command that follows a shell comment containing an apostrophe, or an ANSI-C quoted argument (`$'...'`) with an escaped quote. Before, either could hide the rest of the command, so `rm -rf` after it was not flagged as destructive.

Two detection changes follow from treating `#` comments as comments, both matching what the shell runs. A destructive phrase inside a trailing comment (`echo hi # rm -rf /tmp/x`) is no longer flagged. A `#` line inside a heredoc body is now treated as a comment, so `cat <<EOF` with `# rm -rf /tmp/x` in the body is no longer flagged. A hash after an escaped space is part of a word, not a comment, so `echo a\ #b; rm -rf /tmp/x` is still flagged.
