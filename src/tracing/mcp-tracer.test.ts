import { trace } from '@opentelemetry/api';
import { initMcpTracer, getMcpTracer } from './mcp-tracer.js';

describe('mcp-tracer', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('initMcpTracer initializes the tracer', () => {
    const traceSpy = jest.spyOn(trace, 'getTracer');
    initMcpTracer();
    expect(traceSpy).toHaveBeenCalledWith('preflight', '1.0.0');
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
    traceSpy.mockRestore();
  });
});
