---
'@newrelic/preflight': patch
---

**A token report from a Cursor or Windsurf agent now reaches the budget, Model Usage and the live cost tile.** The pending engine saved the report to the conversation's session file, but the budget never updated, Model Usage hid that conversation, and the live tile got no cost update. The engine now saves the conversation at once and updates the daily and weekly budget from the saved files. While the engine is pending, its session budget follows the conversation that made the report. Model Usage in a `--stdio` engine now reads every other session from its file, because the engine's own tracker holds only its own session. Each report still counts once, also after the engine adopts the conversation. Reports from a pending engine still do not reach New Relic.
