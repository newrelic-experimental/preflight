---
'@newrelic/preflight': patch
---

**On Windows, the GitHub Copilot hooks that `preflight install` writes failed on every tool call, so no Copilot tool calls were recorded.** PowerShell read the `NEW_RELIC_AI_PLATFORM=copilot` prefix on the hook command as a command name. Each hook entry now also has a `powershell` command, which Copilot runs on Windows instead. It sets the platform tag with `$env:` and calls the collector's `.cmd` shim, or its `.exe` shim when Preflight resolved to one, by its full path when the install can resolve it. PowerShell's default execution policy blocks npm's `.ps1` shim, so the hook never calls it. macOS and Linux keep the same command as before. Run `preflight install` again to add the `powershell` command to an existing hooks file, including when the install cannot resolve Preflight's path, as under `npx`.
