/**
 * Classifies a tools/call response by its JSON-RPC body. An MCP server can answer
 * HTTP 200 and still report a failure, either as a JSON-RPC `error` object or as a
 * tool result with `isError: true`. The HTTP status cannot show either case.
 */

import type { RpcOutcome } from './types.js';

/**
 * Largest response body parsed for classification. A bigger body stays unclassified,
 * so a large tool result never adds a JSON.parse to the request path. Separate from
 * the request-body cap (`maxBodyBytes`, 10 MB).
 */
export const MAX_RPC_OUTCOME_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/** True when an MCP tool result reports its own failure with `isError: true`. */
export function isToolErrorResult(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

/** True when a JSON-RPC request body is a tools/call request. */
export function isToolsCallRequest(body: Buffer): boolean {
  const parsed = parseJson(body);
  return isRecord(parsed) && parsed.method === 'tools/call';
}

/**
 * Classifies a tools/call response body. Returns undefined when the body is over
 * MAX_RPC_OUTCOME_BYTES or is not a single JSON-RPC response object with a result or error.
 */
export function classifyToolCallResponse(body: Buffer): RpcOutcome | undefined {
  if (body.length > MAX_RPC_OUTCOME_BYTES) return undefined;
  const parsed = parseJson(body);
  if (!isRecord(parsed)) return undefined;
  if (parsed.error != null) return 'jsonrpc_error';
  if (!('result' in parsed)) return undefined;
  return isToolErrorResult(parsed.result) ? 'tool_error' : 'ok';
}
