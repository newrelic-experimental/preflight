---
'@newrelic/preflight': patch
---

A curl command's credentials are redacted at capture. The value of `-u`, `-U`, `--user`, `--proxy-user` and `-t` is stored as `[REDACTED]`, whether it follows the flag as the next word, in the same word (`-uuser:pass`, `--user=user:pass`) or after other short flags (`-sSu user:pass`). Other curl options and their values, such as `-T` or `-o -t.txt`, are kept.
