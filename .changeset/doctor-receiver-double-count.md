---
'@newrelic/preflight': patch
---

**`preflight doctor` warns when Claude Code's cost may be counted twice in New Relic.** When the OTLP receiver forwards to New Relic, this shell's Claude Code OTel export points at the receiver, and companion mode is off, the Companion mode check now warns and says to set `companionMode: true` if that proxy forwards the metrics. Preflight does not turn companion mode on by itself here, because the receiver runs only in proxy mode and a silent zero in New Relic is worse than a visible double count.
