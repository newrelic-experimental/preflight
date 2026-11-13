---
'@newrelic/preflight': patch
---

Daily budget alerts now follow your local day, the same day your daily spend is counted in. Before, they reset at the UTC day boundary, so outside UTC an alert could fire a second time mid-day or fail to fire after local midnight. A weekly alert fires again once your rolling 7-day spend falls back below the threshold, instead of resetting at an ISO week boundary.
