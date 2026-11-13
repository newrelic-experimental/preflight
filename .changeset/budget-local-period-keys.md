---
'@newrelic/preflight': patch
---

Daily budget alerts now follow your local day, the same day your daily spend is counted in. Before, they reset at the UTC day boundary, so outside UTC an alert could fire a second time mid-day or fail to fire after local midnight. Weekly spend is a rolling 7 days, so a weekly alert fires again once that spend falls 10 percentage points below the threshold (for example under 70% for the 80% alert), instead of resetting at an ISO week boundary. Spend that hovers at the threshold does not re-alert.
