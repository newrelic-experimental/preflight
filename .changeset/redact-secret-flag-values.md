---
'@newrelic/preflight': patch
---

**Secrets passed as command arguments are now redacted before they reach New Relic, local storage or the dashboard.** This covers the value after `--token`, `--password`, `--passwd`, `--secret`, `--api-key`, `--access-key`, `--secret-key` or `--private-key`, in single-dash, underscore and `=` forms, and after compound names that end in one of them, such as `--access-token`, `--client-secret` or `--db-password`. A quoted value is redacted whole. It also covers a `mysql`, `mysqldump`, `mysqladmin` or `mariadb` password written as `-p<password>`, an `X-Api-Key`, `Api-Key`, `X-Auth-Token` or `X-Access-Token` header value passed with `-H` or `--header`, and an `aws_secret_access_key` value. The flag or header name is redacted together with its value, the same way `API_KEY=value` already was. Flags that name a file or stdin, such as `--token-file` and `--password-stdin`, are left as they are.
