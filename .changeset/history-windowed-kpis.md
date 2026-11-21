---
'@newrelic/preflight': patch
---

**History's spend KPIs, daily spend chart and Model performance now count resumed sessions, and agree with "What's contributing to your spend".** They used to read the latest 200 sessions and keep the ones that started in the window. A session resumed inside the window was missed, or counted in full on its start day. They now read the same windowed data as the contributing panel: each session active in the window, with only its in-window cost and tokens, and the daily chart puts that cost on the day it was spent. The 200-session cap no longer limits them, so the "sample doesn't reach back" note is gone. History's 7, 30 and 90 day views now start at local midnight, so the contributing panel and the Tools table cover the same days as the chart.
