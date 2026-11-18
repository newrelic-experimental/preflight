---
'@newrelic/preflight': minor
---

The Skills, Subagents and Plugins tables under "What's contributing to your spend" now show each token category's dollar cost next to its token count in the row's hover, for example "Cache read 30.0k ($0.09)". This shows which category drives a row's cost, since cache-read tokens cost far less than input or output tokens. Costs are priced per model as they are recorded, so sessions saved before this release show tokens only, and a row that includes such a session also shows tokens only.
