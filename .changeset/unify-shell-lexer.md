---
'@newrelic/preflight': patch
---

**Pull request status and Git Efficiency now read each Bash command one way.** Preflight read a command twice before classifying it: once to drop heredoc bodies, once to split it into commands. The two reads handled backslashes, `#` comments and `$( … )` inside double quotes differently, so they could disagree about what a command ran. A `gh pr merge` could then go uncounted, and quoted text could count as a git step. One example is the `git status` in `git commit -m "$(echo "a; git status")"`. Both now come from a single reading. A `"$( … )"` with a quote inside it no longer splits the command, and an escaped `\<<` is no longer taken for a heredoc. When the reading is unsure, the merge still goes uncounted rather than counted by mistake.
