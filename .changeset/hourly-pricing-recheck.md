---
'@newrelic/preflight': patch
---

A long-running server now rechecks LiteLLM prices every hour, so a model released while it is up gets priced without a restart. It refetches only once its price cache is a day old.
