export { processHook, redact, hashInput, sizeOf, truncate } from './collector-script.js';
export { HookEventProcessor } from './event-processor.js';
export type { HookEventProcessorOptions } from './event-processor.js';
export { parseToolSpecificFields } from './tool-parsers.js';
export {
  resolveSessionId,
  sessionBreadcrumbs,
  nextDelayMs,
  isSyntheticSessionId,
} from './session-resolver.js';
export type { SessionBreadcrumbs, SessionResolverOptions } from './session-resolver.js';
