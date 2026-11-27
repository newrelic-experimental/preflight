---
'@newrelic/preflight': patch
---

**A destructive command after a credential inside `bash -c "…"` now stays flagged.** When a credential's value held a quote that the inner command reads as opening a string, such as `\"` or `'`, and the `bash -c` string closed first, the stored command dropped that quote. The command after it then read as quoted text, so a later `rm` was no longer flagged as destructive. This covered the secret flags such as `--token`, `NAME=` values, mysql `-p`, curl credentials, `docker login -p`, `sshpass -p`, `redis-cli -a` and unquoted credential headers, with or without a line continuation. Such a value now keeps its quotes, backslashes and `$` in place, and only the text between them is redacted, as in `curl [REDACTED]\"[REDACTED]`. Redaction cannot tell `bash -c "…"` from another quoted string such as `echo "…"`, so the same holds there.
