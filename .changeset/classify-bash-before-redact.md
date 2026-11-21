---
'@newrelic/preflight': patch
---

A Bash command that a secret redaction rewrites is still flagged destructive or network. The hook collector now classifies the raw command before redacting it and stores only the two flags beside the redacted text. Events from an older collector are still classified from their stored text.
