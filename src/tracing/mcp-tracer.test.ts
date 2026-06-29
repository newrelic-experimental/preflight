import { trace } from '@opentelemetry/api';
import { initMcpTracer, getMcpTracer } from './mcp-tracer.js';
import { VERSION } from '../version.js';

describe('mcp-tracer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('initMcpTracer initializes the tracer', () => {
    const traceSpy = jest.spyOn(trace, 'getTracer');
    initMcpTracer();
    expect(traceSpy).toHaveBeenCalledWith('preflight', VERSION);
    traceSpy.mockRestore();
  });

  test('getMcpTracer returns non-null tracer', () => {
    initMcpTracer();
    const tracer = getMcpTracer();
    expect(tracer).not.toBeNull();
  });

  test('getMcpTracer returns tracer without prior init', () => {
    const tracer = getMcpTracer();
    expect(tracer).not.toBeNull();
  });

  test('initMcpTracer calls getTracer each time it is invoked', () => {
    const traceSpy = jest.spyOn(trace, 'getTracer');
    initMcpTracer();
    initMcpTracer();
    expect(traceSpy).toHaveBeenCalledTimes(2);
  });
});
