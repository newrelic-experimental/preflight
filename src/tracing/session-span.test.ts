import { SpanStatusCode } from '@opentelemetry/api';
import { SessionSpan } from './session-span.js';

const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};

const mockTracer = { startSpan: jest.fn(() => mockSpan) };

jest.mock('./mcp-tracer.js', () => ({ getMcpTracer: () => mockTracer }));

describe('SessionSpan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('start creates a span with correct attributes', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();

    expect(mockTracer.startSpan).toHaveBeenCalledWith('ai.coding.session', {
      attributes: {
        'ai.session.id': 'test-session-id',
        'ai.developer': 'test-developer',
        'ai.platform': 'claude-code',
      },
    });
  });

  test('start is idempotent', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();
    session.start();

    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  });

  test('end sets attributes and ends the span', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();
    session.end(5, 2);

    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      'ai.session.tool_call_count': 5,
      'ai.session.task_count': 2,
    });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  test('end clears the internal span reference', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();
    session.end(5, 2);

    expect(session.getSpan()).toBeNull();
  });

  test('getSpan returns null when span is not active', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    expect(session.getSpan()).toBeNull();
  });

  test('getSpan returns span after start', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();

    expect(session.getSpan()).not.toBeNull();
  });

  test('getContext returns a context containing the span after start', () => {
    const { trace } = jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();

    const ctx = session.getContext();
    expect(trace.getSpan(ctx)).toBe(mockSpan);
  });

  test('getContext returns active context when span is not started', () => {
    const { context } =
      jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
    const session = new SessionSpan('test-session-id', 'test-developer');

    const ctx = session.getContext();
    expect(ctx).toBe(context.active());
  });

  test('end is a no-op when called before start', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.end(0, 0);

    expect(mockTracer.startSpan).not.toHaveBeenCalled();
    expect(mockSpan.end).not.toHaveBeenCalled();
  });

  test('end is idempotent when called a second time', () => {
    const session = new SessionSpan('test-session-id', 'test-developer');
    session.start();
    session.end(5, 2);
    session.end(5, 2);

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});
