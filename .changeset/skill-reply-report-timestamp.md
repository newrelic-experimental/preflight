---
'@newrelic/preflight': patch
---

A text-only skill reply is now stamped with the skill run that was open when the reply was written. Before, Preflight used the run open when it read the reply's token report, so a prompt sent within about 2 seconds after a reply could drop that reply's skill or give it the next `/<skill>` run.
