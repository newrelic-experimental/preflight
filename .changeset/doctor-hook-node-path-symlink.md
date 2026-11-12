---
'@newrelic/preflight': patch
---

**`preflight doctor` no longer warns about the hook's Node path when the hook runs from a version-manager alias.** With hooks installed under an fnm or nvm alias such as `~/.local/share/fnm/aliases/default/bin`, doctor compared that symlinked folder with the real Node install it points to, reported them as different, and told you to re-run setup, which changed nothing. Doctor now resolves symlinks before comparing.
