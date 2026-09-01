/**
 * Health check for the bundled GitHub Copilot SDK usage-capture extension
 * (`copilot-sdk-extension/extension.mjs`) — detects the one failure cause
 * that's checkable from the MCP server process without a live-session
 * signal: the extension was never copied to its documented install path (see
 * `getHookInstallInstructions()` in `../platforms/copilot-sdk-adapter.js`).
 * Deliberately does NOT catch the issue's other named causes (`--experimental`
 * not set, a version-incompatible `joinSession()`, an unwritable storage
 * dir) — none of those are filesystem-observable from this process. Same
 * partial-coverage tradeoff already accepted by `CopilotUsageWatcher`'s
 * `debugLoggingLikelyDisabled` (see that type's doc comment).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function copilotSdkExtensionInstallPath(): string {
  return join(homedir(), '.copilot', 'extensions', 'preflight', 'extension.mjs');
}

/**
 * True only when `platformName` is `'copilot-sdk'` and the extension isn't
 * at its documented install path. Always false for every other platform —
 * the extension is copilot-sdk-only, so its absence there is meaningless.
 */
export function isCopilotSdkExtensionMissing(platformName: string): boolean {
  if (platformName !== 'copilot-sdk') return false;
  return !existsSync(copilotSdkExtensionInstallPath());
}
