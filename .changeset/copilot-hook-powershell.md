---
'@newrelic/preflight': patch
---

**On Windows, the GitHub Copilot hooks that `preflight install` writes failed on every tool call, so no Copilot tool calls were recorded.** PowerShell read the `NEW_RELIC_AI_PLATFORM=copilot` prefix on the hook command as a command name. Each hook entry now also has a `powershell` command, which Copilot runs on Windows instead. It sets the platform tag with `$env:` and calls the collector's `.cmd`, `.ps1`, or `.exe` shim by its full path. macOS and Linux keep the same command as before. Run `preflight install` again to update an existing hooks file.
