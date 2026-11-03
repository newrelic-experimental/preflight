---
'@newrelic/preflight': patch
---

**On Windows, `preflight install` now wires hooks and the MCP server through a Node version manager's stable `.exe` shim, so they keep working after a Node upgrade.** The install used to skip a PATH directory that held only `preflight.exe`, such as mise's default shim directory, and fall back to a path inside a versioned Node install that breaks once that version is pruned. Preflight now resolves `preflight.exe`, writes the hook command as `preflight-collector.exe` in the same directory, and recognizes both forms on reinstall and uninstall. npm's global directory still resolves to the `.cmd` shim as before. A native `copilot.exe` on PATH is now found too, so `preflight install --copilot` registers the MCP server with the Copilot CLI and installs its usage extension, as it already did for an npm-installed `copilot.cmd`.
