---
'@newrelic/preflight': patch
---

The Bash classifier no longer misses `rm -rf` after a backslash-escaped quote (`echo it\'s; rm -rf x`), an apostrophe in a `#` comment, an ANSI-C quoted argument (`$'...'`) with an escaped quote, or a heredoc body containing a quote. Quote masking now follows one shell rule: outside single quotes a backslash escapes the next character, and an escaped character never opens a quote or a comment. On 3,000 generated commands checked against real bash, the classifier went from missing 518 of 1,499 runs of `rm -rf` to missing none.

A destructive phrase inside a trailing comment (`echo hi # rm -rf /tmp/x`) is no longer flagged, which matches what bash runs. Heredoc bodies stay visible to the check, so `$(rm -rf x)` inside one is still flagged.
