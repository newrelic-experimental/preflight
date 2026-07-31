import { pairToolCallsFromBufferEvents } from './tool-selection-aggregate.js';
import type { PreHookEvent, PostHookEvent } from '../../storage/types.js';

function pre(overrides: Partial<PreHookEvent> = {}): PreHookEvent {
  return {
    mode: 'pre',
    tool: 'Read',
    timestamp: 1000,
    toolUseId: 'tu-1',
    sessionId: 'sess-a',
    toolInput: { file_path: '/src/foo.ts' },
    ...overrides,
  };
}

function post(overrides: Partial<PostHookEvent> = {}): PostHookEvent {
  return {
    mode: 'post',
    tool: 'Read',
    timestamp: 1010,
    toolUseId: 'tu-1',
    sessionId: 'sess-a',
    toolOutput: {},
    outputSize: 5000,
    success: true,
    ...overrides,
  } as PostHookEvent;
}

describe('pairToolCallsFromBufferEvents', () => {
  it('pairs a matching pre/post by (sessionId, toolUseId) into a ToolCallRecord with filePath and outputSizeBytes', () => {
    const records = pairToolCallsFromBufferEvents([pre(), post()]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'sess-a',
      toolName: 'Read',
      toolUseId: 'tu-1',
      timestamp: 1010,
      success: true,
      outputSizeBytes: 5000,
      filePath: '/src/foo.ts',
    });
  });

  it('pairs correctly regardless of array order (pre after post)', () => {
    const records = pairToolCallsFromBufferEvents([post(), pre()]);
    expect(records).toHaveLength(1);
    expect(records[0]?.filePath).toBe('/src/foo.ts');
  });

  it('defaults success to true when the post event omits it', () => {
    const records = pairToolCallsFromBufferEvents([pre(), post({ success: undefined })]);
    expect(records[0]?.success).toBe(true);
  });

  it('skips unmatched post events (no corresponding pre)', () => {
    const records = pairToolCallsFromBufferEvents([post({ toolUseId: 'orphan' })]);
    expect(records).toHaveLength(0);
  });

  it('skips post events without a toolUseId', () => {
    const records = pairToolCallsFromBufferEvents([
      pre({ toolUseId: undefined }),
      post({ toolUseId: undefined }),
    ]);
    expect(records).toHaveLength(0);
  });

  it('does not cross-pair events from different sessions sharing the same toolUseId', () => {
    const records = pairToolCallsFromBufferEvents([
      pre({ sessionId: 'sess-a' }),
      post({ sessionId: 'sess-b' }),
    ]);
    expect(records).toHaveLength(0);
  });

  it('ignores token/subagent_token/observability_health/workflow_run events', () => {
    const records = pairToolCallsFromBufferEvents([
      pre(),
      post(),
      { mode: 'token', tool: '', timestamp: 1020, inputTokens: 10, outputTokens: 5 },
    ]);
    expect(records).toHaveLength(1);
  });
});
