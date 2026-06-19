import { trace, type Tracer } from '@opentelemetry/api';
import { createLogger } from '../shared/index.js';

const logger = createLogger('mcp-tracer');
const SCOPE = 'preflight';
const VERSION = '1.0.0'; // keep in sync with package.json

let _tracer: Tracer | null = null;

export function initMcpTracer(): void {
  _tracer = trace.getTracer(SCOPE, VERSION);
  logger.debug('MCP tracer initialized');
}

export function getMcpTracer(): Tracer {
  return _tracer ?? trace.getTracer(SCOPE, VERSION);
}
