---
'@newrelic/preflight': patch
---

A tool call from a platform whose hooks send no tool-use id now counts once when one Preflight process sees its start and another sees its end, such as across an engine restart. Before, it counted twice: once as a timeout and once as an orphan. The collector now gives each such call an id at its start and hands the same id to its end.
