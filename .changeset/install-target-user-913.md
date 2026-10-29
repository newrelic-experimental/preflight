---
'@newrelic/preflight': minor
---

`preflight install --target-user <name>` lets a root-run script, such as a Jamf policy, configure a specific user's home instead of root's. The install runs as that user, so their `config.json`, Claude Code hooks and MCP registration are created with the right owner and the usual `0600` and `0700` modes. A root install without `--target-user` now warns which home it is configuring.
