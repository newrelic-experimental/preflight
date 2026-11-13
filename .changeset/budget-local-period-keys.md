---
'@newrelic/preflight': patch
---

Daily budget alerts now follow your local day, the same day your daily spend is counted in. Before, the budget tracker reset at the UTC day boundary, so outside UTC an alert could fire a second time mid-day or fail to fire after local midnight. Weekly spend is a rolling 7 days, so a weekly alert no longer resets at an ISO week boundary. It fires again only once that spend falls 10 percentage points below the threshold (for example under 70% for the 80% alert), and the weekly alert rule clears at that same point. Spend that hovers at the threshold does not re-alert. The 10 point margin is a constant in the source (`WEEKLY_REARM_MARGIN_PCT`) that an operator can change.
