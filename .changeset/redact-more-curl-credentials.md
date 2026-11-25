---
'@newrelic/preflight': patch
---

Redacts more credentials in curl commands before they are stored: the values of `--oauth2-bearer`, `--pass`, `--proxy-pass`, `--tlspassword`, `--proxy-tlspassword`, `--cookie` and `-b`, and an `Authorization` or API key header written right after `-H`, as in `-H"Authorization: Basic …"`. A long option that takes a value now consumes its value the way curl does, so `--pass hunter2 --key k.pem` stores `--key k.pem` as is.
