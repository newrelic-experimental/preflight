---
'@newrelic/preflight': patch
---

**A credential after an apostrophe in prose, inside `"$(…)"` or next to a line continuation is now redacted.** `Don't paste this: curl -u 'me:pass word' x`, `echo "$(curl -u "me:pass word" x)"`, `curl -u\` with an indented `'me:pass word'` on the next line, and `curl x \` with `-u 'me:pass word'` on the next line were stored with the credential in clear text, in part or whole. The same holds for a quoted header after `-H`, a quoted `Name:value` header (which also covers `curl -sH`), the secret flags and `NAME=` values, and for a line continuation after `docker login -p`, `sshpass -p` and `redis-cli -a`. A quoted value is taken whole only when it holds plain characters, spaces and tabs on one line. Otherwise it is read as before, so the command after it stays classifiable. A JSON-escaped line break now ends a curl, mysql, docker, sshpass or redis-cli command, so `curl x\nls -u f` recorded inside JSON keeps `ls -u f`.
