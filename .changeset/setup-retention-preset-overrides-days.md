---
'@newrelic/preflight': patch
---

`preflight setup --retention <preset>` now takes effect on a config that already sets `retainSessionsDays`. Choosing a preset by flag or in the wizard removes the old day count from `config.json` and prints the value it removed. Pressing Enter keeps the day count, which still takes precedence.
