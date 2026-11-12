---
'@newrelic/preflight': minor
---

**The unpriced-calls notice counts the right calls, and `droppedTokenEvents` is now `evictedToolBursts`.** Three fixes to how Preflight counts calls it could not price exactly.

- A session that began on byte-size estimates no longer keeps their calls in its unpriced and estimated-price counts after the first real token report replaces them. The calls are now taken back out along with the estimated cost, including after a restart and when two Preflight processes save the same session. The estimate counts of a session already on disk before this version cannot be taken back out.
- The Today page's unpriced-calls notice counts only the calls made today. A session that started yesterday used to add all of its unpriced calls beside a Spend Today figure that covered today alone. Session files now keep these counts per local day as `unpricedByDay` and `estimatedByDay`. A session saved by an older version has no day split, so the notice keeps counting all of its calls until the session is resumed. Its earlier calls are then booked to the last day it was active.
- `nr_observe_get_cost_per_tool` now returns `evictedToolBursts` instead of `droppedTokenEvents`, so anything that reads the old field must change. The old name read as "token reports that were dropped", but every token report now reaches `AiTurnCost`. The field counts only tool-call bursts evicted without a closing report, whose cost is lost. The count is unchanged.
