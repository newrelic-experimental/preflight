---
'@newrelic/preflight': patch
---

**A credential header joined to `-H` without a quote is now redacted.** `curl -HX-Api-Key:…` and `curl -HAuthorization:Basic …` were stored with the credential in clear text. They are now stored as `curl -H[REDACTED]`, like the quoted joined form `curl -H"…"`. The same holds for `Proxy-Authorization: Basic` and the other API-key headers, and for commands recorded inside JSON. A joined header must start with one of these credential names, so flags such as `du -Hs` or `grep -H` and a header such as `curl -Hfoo:bar` are left as they are. It applies to the stored command and to recorded content alike.
