---
'@newrelic/preflight': patch
---

**A credential header after a curl `-H` bundled with other short flags is now redacted.** `curl -sSH X-Api-Key:…` and `curl -sHX-Api-Key:…` were stored with the credential in clear text. They are now stored as `curl -sSH [REDACTED]` and `curl -sH[REDACTED]`, like `curl -H [REDACTED]`. The same holds for quoted headers, for `Authorization: Basic` and `Proxy-Authorization: Basic`, and for commands recorded inside JSON. A quoted header after a bundled `-H` is now hidden whole, name included, as after a lone `-H`. The bundle is read only after `curl`, so `grep -rH`, `du -sH` and `ls -lH` are left as they are, and so is a header such as `curl -sH foo:bar`. It applies to the stored command and to recorded content alike.
