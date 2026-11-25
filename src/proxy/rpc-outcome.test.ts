import { describe, it, expect } from '@jest/globals';
import {
  MAX_RPC_OUTCOME_BYTES,
  classifyToolCallResponse,
  isToolErrorResult,
  isToolsCallRequest,
} from './rpc-outcome.js';

describe('classifyToolCallResponse', () => {
  const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

  it('returns ok for a result with no failure marker', () => {
    expect(classifyToolCallResponse(body({ jsonrpc: '2.0', id: 1, result: { content: [] } }))).toBe(
      'ok',
    );
  });

  it('returns ok for a result whose isError is false', () => {
    expect(
      classifyToolCallResponse(body({ jsonrpc: '2.0', id: 1, result: { isError: false } })),
    ).toBe('ok');
  });

  it('returns jsonrpc_error for an error object', () => {
    expect(
      classifyToolCallResponse(
        body({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'x' } }),
      ),
    ).toBe('jsonrpc_error');
  });

  it('returns tool_error for a result with isError true', () => {
    expect(
      classifyToolCallResponse(body({ jsonrpc: '2.0', id: 1, result: { isError: true } })),
    ).toBe('tool_error');
  });

  it('treats a null error member as no error', () => {
    expect(classifyToolCallResponse(body({ jsonrpc: '2.0', id: 1, error: null, result: {} }))).toBe(
      'ok',
    );
  });

  it('returns undefined for a body that is not JSON', () => {
    expect(classifyToolCallResponse(Buffer.from('event: message'))).toBeUndefined();
  });

  it('returns undefined for a JSON array or a JSON object with neither result nor error', () => {
    expect(classifyToolCallResponse(body([{ jsonrpc: '2.0', id: 1, result: {} }]))).toBeUndefined();
    expect(classifyToolCallResponse(body({ jsonrpc: '2.0', id: 1 }))).toBeUndefined();
  });

  it('returns undefined for a body over MAX_RPC_OUTCOME_BYTES', () => {
    const oversized = Buffer.alloc(MAX_RPC_OUTCOME_BYTES + 1, ' ');
    oversized.write('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}');
    expect(classifyToolCallResponse(oversized)).toBeUndefined();
  });
});

describe('isToolsCallRequest', () => {
  it('is true for a tools/call request', () => {
    expect(isToolsCallRequest(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}'))).toBe(
      true,
    );
  });

  it('is false for another method or an unparseable body', () => {
    expect(isToolsCallRequest(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))).toBe(
      false,
    );
    expect(isToolsCallRequest(Buffer.from('not json'))).toBe(false);
  });
});

describe('isToolErrorResult', () => {
  it('is true only for an object with isError strictly true', () => {
    expect(isToolErrorResult({ isError: true })).toBe(true);
    expect(isToolErrorResult({ isError: 'true' })).toBe(false);
    expect(isToolErrorResult({ content: [] })).toBe(false);
    expect(isToolErrorResult(null)).toBe(false);
    expect(isToolErrorResult(undefined)).toBe(false);
  });
});
