---
'@newrelic/preflight': patch
---

**The Today concurrency chart no longer drops the last hour on the day clocks go back.** The grid was always 24 hours long, so on the 25-hour fall-back day activity after 23:00 was missing from the chart and today's peak, and the History bar then changed the next day. The grid now covers the local day, which gives 100 buckets on the fall-back day and 92 on the spring-forward day.
