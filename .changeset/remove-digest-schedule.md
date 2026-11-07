---
'@newrelic/preflight': patch
---

**The digest schedule setting is removed because nothing read it.** Preflight never sent digests on a timer, so the `digestSchedule` config key, the `NEW_RELIC_AI_DIGEST_SCHEDULE` variable, and the schedule input on the Alerts page are gone. Digests are still sent on demand with `nr_observe_send_digest`. To send one on a schedule, run an external cron job or CI schedule that calls `nr_observe_send_digest`. A config file that still sets `digestSchedule` loads and logs the usual unknown-key warning.
