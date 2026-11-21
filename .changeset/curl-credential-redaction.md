---
'@newrelic/preflight': patch
---

A curl command's credentials are redacted at capture. The value of `-u`, `-U`, `--user`, `--proxy-user` and `-t` is stored as `[REDACTED]`, whether it follows the flag as the next word, in the same word (`-uuser:pass`) or after other short flags (`-sSu user:pass`). Other curl options and their values, such as `-T` or `-o -t.txt`, are kept. A curl or mysql command right after a JSON escape or ANSI colour code, as in recorded tool input (`cd /tmp\ncurl -u user:pass`), now has its password redacted too. Before, a mysql `-p` password in that position was stored as is.
