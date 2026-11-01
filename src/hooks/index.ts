export { processHook, redact, hashInput, sizeOf, truncate } from './collector-script.js';
export { amendRecord, HookEventProcessor } from './event-processor.js';
export type { HookEventProcessorOptions } from './event-processor.js';
export { parseToolSpecificFields } from './tool-parsers.js';
export {
  resolveSessionId,
  resolveFromJobDir,
  resolveFromBreadcrumb,
  nextDelayMs,
  isSyntheticSessionId,
} from './session-resolver.js';
export type { SessionResolverOptions } from './session-resolver.js';
