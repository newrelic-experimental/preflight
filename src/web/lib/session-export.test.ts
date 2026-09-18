import type { TurnCostsResponse } from '../api/client';
import { sessionLink, sessionToJson, sessionToMarkdown } from './session-export.js';

function turn(model: string): TurnCostsResponse['turns'][number] {
  return {
    turnId: model,
    startTime: 0,
    endTime: 1,
    toolCalls: [],
    toolNames: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    model,
    estimatedCostUsd: 0.1,
    costPerToolCall: 0,
  };
}

describe('sessionToMarkdown', () => {
  it('falls back to the short session id and leaves out missing fields', () => {
    expect(sessionToMarkdown({ session: { sessionId: 'abcdef1234567890' } })).toBe(
      '### Session: abcdef12',
    );
  });

  it('summarises every field it has, with the top three tools and anti-patterns', () => {
    const text = sessionToMarkdown({
      session: {
        sessionId: 's1',
        sessionName: 'preflight',
        startTime: Date.UTC(2026, 8, 18, 10, 0),
        durationMs: 198_000,
        toolCallCount: 12,
        toolBreakdown: { Read: 6, Edit: 3, Bash: 2, Grep: 1 },
        estimatedCostUsd: 0.42,
        toolSuccessRate: 0.917,
        model: 'claude-sonnet-5',
        antiPatterns: [
          { type: 'redundant_read', count: 2 },
          { type: 'retry_loop' },
          { type: 'redundant_read', count: 1 },
        ],
      },
      decisionTree: {
        totalBranches: 4,
        successRate: 0.75,
        failurePoints: [],
        longestFailureStreak: 2,
        firstFailureIndex: null,
        note: '',
      },
      turnCosts: {
        turns: [turn('claude-sonnet-5'), turn('claude-opus-5')],
        costByToolType: {},
        totalAttributedCost: 0.2,
        attributionRate: 1,
      },
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('### Session: preflight');
    expect(lines[1]).toMatch(/^- Started: .+ \(3m 18s\)$/);
    expect(lines.slice(2)).toEqual([
      '- Estimated cost: $0.42',
      '- Tool calls: 12 (Read 6, Edit 3, Bash 2)',
      '- Tool success rate: 92%',
      '- Models: claude-sonnet-5, claude-opus-5',
      '- Longest failure streak: 2',
      '- Top anti-patterns: redundant_read 3, retry_loop 1',
    ]);
    expect(lines.length).toBeLessThanOrEqual(15);
  });

  it('treats an empty name and zero tool calls as missing', () => {
    expect(
      sessionToMarkdown({
        session: { sessionId: 'abcdef1234567890', sessionName: '', toolCallCount: 0 },
      }),
    ).toBe('### Session: abcdef12');
  });

  it('uses the attributed turn cost when the session has no estimate', () => {
    const text = sessionToMarkdown({
      session: { sessionId: 's1', estimatedCostUsd: null },
      turnCosts: { turns: [], costByToolType: {}, totalAttributedCost: 0.2, attributionRate: 1 },
    });
    expect(text).toContain('- Estimated cost: $0.20');
  });
});

describe('sessionToJson', () => {
  it('pretty-prints the session summary', () => {
    const session = { sessionId: 's1', toolCallCount: 2 };
    expect(sessionToJson({ session })).toBe('{\n  "sessionId": "s1",\n  "toolCallCount": 2\n}');
  });
});

describe('sessionLink', () => {
  it('points at the Sessions view and encodes the id', () => {
    expect(sessionLink('http://localhost:7777', 'a b/c')).toBe(
      'http://localhost:7777/sessions?id=a%20b%2Fc',
    );
  });
});
