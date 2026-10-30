---
'@newrelic/preflight': minor
---

`preflight install` can now read the license key from `--license-key-file <path>` and fall back to `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID`, so scripted and MDM installs no longer have to put the key on the command line where `ps` shows it. The flag wins over the file, and the file wins over the environment. A key file that other users can read produces a warning.
