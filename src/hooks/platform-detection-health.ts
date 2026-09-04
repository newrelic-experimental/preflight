/**
 * True when the session-level active platform (see
 * `HookEventProcessor.activePlatform`) resolved to the generic MCP fallback
 * instead of a named platform — the detector found none of the
 * platform-specific env signals it looks for, so tool calls and session
 * summaries are filing under the generic fallback instead of the real host.
 * Extracted from the observability-health snapshot closure in `index.ts` so
 * the computation itself is unit-testable without spawning the real binary,
 * matching `isCopilotSdkExtensionMissing`'s pattern in
 * `copilot-sdk-extension-health.ts`.
 */

import { GENERIC_MCP_PLATFORM_NAME } from '../platforms/generic-mcp-adapter.js';

export function isPlatformDetectionFellBack(activePlatform: string): boolean {
  return activePlatform === GENERIC_MCP_PLATFORM_NAME;
}
