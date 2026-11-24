---
'@newrelic/preflight': patch
---

**History's "What's contributing to your spend" and the windowed cost per tool now count resumed sessions.** A session keeps its start date in its filename. These views picked sessions by that date, so a session started before the window and resumed inside it was left out. They now include every session with activity in the window and count only the part inside it: cost from the session's per-day record, and calls from its timeline, or from its call count scaled by its cost share when the timeline dropped older calls. The window starts at local midnight, like the rest of History. History's Tools table now takes its calls, cost and share from that windowed data, and shows no rows when that data has none. Other windowed views still pick sessions by start date too.
