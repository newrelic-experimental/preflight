---
'@newrelic/preflight': patch
---

**More secrets passed as command arguments are now redacted before they reach New Relic, local storage or the dashboard.** This covers the `user:password` after `curl -u` or `curl --user`, an `Authorization: Basic` header passed with `-H` or `--header`, the password after `-p` in `docker login`, the password after `-p` in `sshpass`, and the password after `-a` or `--pass` in `redis-cli`. Each rule applies only to its own command, so `docker run -p 8080:80`, `ssh -p 2222`, `ls -a`, `useradd -u 1001` and `curl -u alice` (which prompts for the password) are left as they are.
