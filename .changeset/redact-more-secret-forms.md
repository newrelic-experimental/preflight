---
'@newrelic/preflight': patch
---

**More passwords passed as command arguments are now redacted before they reach New Relic, local storage or the dashboard.** This covers an `Authorization: Basic` header passed with `-H` or `--header`, the password after `-p` in `docker login`, the password after `-p` in `sshpass`, and the password after `-a` or `--pass` in `redis-cli`. It applies to the stored command and to recorded content alike. Each rule applies only to its own command, so `docker run -p 8080:80`, `redis-cli -p 6380` and the `ssh -p 2222` that `sshpass` wraps are left as they are.
