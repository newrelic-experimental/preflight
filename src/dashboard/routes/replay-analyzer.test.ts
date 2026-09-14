import { describe, it, expect } from '@jest/globals';
import { analyzeReplayTimeline } from './replay-analyzer.js';
import type { ReplayTimelineEntry } from '../../storage/types.js';

function makeEntry(overrides?: Partial<ReplayTimelineEntry>): ReplayTimelineEntry {
  return {
    timestamp: Date.now(),
    toolName: 'Read',
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

describe('analyzeReplayTimeline', () => {
  it('returns empty segments for a clean timeline', () => {
    const timeline = [
      makeEntry({ toolName: 'Read', filePath: '/a.ts' }),
      makeEntry({ toolName: 'Edit', filePath: '/a.ts' }),
      makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: true }),
    ];
    const result = analyzeReplayTimeline(timeline);
    expect(result.segments).toHaveLength(0);
    expect(result.worstSegment).toBeNull();
  });

  describe('thrashing detection', () => {
    it('detects edit-test-fail cycle >= 3 iterations', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
        timeline.push(
          makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: false }),
        );
      }

      const result = analyzeReplayTimeline(timeline);
      const thrash = result.segments.filter((s) => s.type === 'thrashing');
      expect(thrash.length).toBeGreaterThanOrEqual(1);
      expect(thrash[0]!.target).toBe('/src/bug.ts');
      expect(thrash[0]!.iterations).toBeGreaterThanOrEqual(3);
    });

    it('ends thrashing segment when test passes', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
        timeline.push(
          makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: false }),
        );
      }
      timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts' }));
      timeline.push(
        makeEntry({ toolName: 'Bash', command: 'npm test', isTestCommand: true, success: true }),
      );
      // Add more entries after the pass — they should not be in the segment
      timeline.push(makeEntry({ toolName: 'Read', filePath: '/src/other.ts' }));

      const result = analyzeReplayTimeline(timeline);
      const thrash = result.segments.filter((s) => s.type === 'thrashing');
      expect(thrash).toHaveLength(1);
      expect(thrash[0]!.endIndex).toBeLessThan(timeline.length - 1);
    });
  });

  describe('stuck loop detection', () => {
    it('detects same command run >= 3 consecutive times', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.iterations).toBe(4);
      expect(stuck[0]!.target).toBe('npm test');
      expect(stuck[0]!.startIndex).toBe(0);
      expect(stuck[0]!.endIndex).toBe(3);
    });

    it('does not flag different commands as stuck', () => {
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test' }),
        makeEntry({ toolName: 'Bash', command: 'npm build' }),
        makeEntry({ toolName: 'Bash', command: 'npm lint' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(0);
    });
  });

  describe('blind editing detection', () => {
    it('detects >= 3 edits to same file without reading it', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 4; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }));
      }

      const result = analyzeReplayTimeline(timeline);
      const blind = result.segments.filter((s) => s.type === 'blind_editing');
      expect(blind).toHaveLength(1);
      expect(blind[0]!.iterations).toBe(4);
      expect(blind[0]!.target).toBe('/src/x.ts');
    });

    it('resets count when file is read', () => {
      const timeline = [
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const blind = result.segments.filter((s) => s.type === 'blind_editing');
      expect(blind).toHaveLength(0);
    });
  });

  describe('re-reading detection', () => {
    it('detects reading same file >= 4 times', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 5; i++) {
        timeline.push(makeEntry({ toolName: 'Read', filePath: '/src/big.ts' }));
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/other.ts' }));
      }

      const result = analyzeReplayTimeline(timeline);
      const reread = result.segments.filter((s) => s.type === 're_reading');
      expect(reread).toHaveLength(1);
      expect(reread[0]!.iterations).toBe(5);
      expect(reread[0]!.target).toBe('/src/big.ts');
    });

    it('does not flag file read only 3 times', () => {
      const timeline = [
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
        makeEntry({ toolName: 'Read', filePath: '/src/a.ts' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const reread = result.segments.filter((s) => s.type === 're_reading');
      expect(reread).toHaveLength(0);
    });
  });

  describe('severity', () => {
    it('marks >= 5 iterations as critical', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 6; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck[0]!.severity).toBe('critical');
    });

    it('marks < 5 iterations as warning', () => {
      const timeline: ReplayTimelineEntry[] = [];
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck[0]!.severity).toBe('warning');
    });
  });

  describe('agent partitioning', () => {
    it('does not flag stuck_loop when 3 different subagents each run the same command once', () => {
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }),
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-b' }),
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-c' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      expect(result.segments.filter((s) => s.type === 'stuck_loop')).toHaveLength(0);
    });

    it('still flags stuck_loop when one subagent repeats a command 3+ times', () => {
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }),
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }),
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.iterations).toBe(3);
    });

    it('stamps agentScoped true with agentId undefined for a parent-session-only segment', () => {
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test' }),
        makeEntry({ toolName: 'Bash', command: 'npm test' }),
        makeEntry({ toolName: 'Bash', command: 'npm test' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.agentScoped).toBe(true);
      expect(stuck[0]!.agentId).toBeUndefined();
    });

    it('does not flag blind_editing when 4 different subagents each edit the same file once', () => {
      const timeline = [
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts', agentId: 'agent-a' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts', agentId: 'agent-b' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts', agentId: 'agent-c' }),
        makeEntry({ toolName: 'Edit', filePath: '/src/x.ts', agentId: 'agent-d' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      expect(result.segments.filter((s) => s.type === 'blind_editing')).toHaveLength(0);
    });

    it('does not flag re_reading when 4 different subagents each read the same file once', () => {
      const timeline = [
        makeEntry({ toolName: 'Read', filePath: '/src/big.ts', agentId: 'agent-a' }),
        makeEntry({ toolName: 'Read', filePath: '/src/big.ts', agentId: 'agent-b' }),
        makeEntry({ toolName: 'Read', filePath: '/src/big.ts', agentId: 'agent-c' }),
        makeEntry({ toolName: 'Read', filePath: '/src/big.ts', agentId: 'agent-d' }),
      ];
      const result = analyzeReplayTimeline(timeline);
      expect(result.segments.filter((s) => s.type === 're_reading')).toHaveLength(0);
    });

    it('maps a per-agent segment back to the correct original indices when another agent interleaves', () => {
      // agent-a: stuck loop at original indices 0, 2, 3 (idx 1 belongs to agent-b)
      const timeline = [
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }), // 0
        makeEntry({ toolName: 'Read', filePath: '/other.ts', agentId: 'agent-b' }), // 1
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }), // 2
        makeEntry({ toolName: 'Bash', command: 'npm test', agentId: 'agent-a' }), // 3
      ];
      const result = analyzeReplayTimeline(timeline);
      const stuck = result.segments.filter((s) => s.type === 'stuck_loop');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]!.iterations).toBe(3);
      expect(stuck[0]!.startIndex).toBe(0);
      expect(stuck[0]!.endIndex).toBe(3);
      // agentScoped + agentId let the renderer skip non-owning rows within
      // this range (e.g. agent-b's entry at index 1) instead of painting
      // every index in [startIndex, endIndex] as part of the segment.
      expect(stuck[0]!.agentScoped).toBe(true);
      expect(stuck[0]!.agentId).toBe('agent-a');
    });

    it('leaves thrashing unpartitioned across agents (matches AntiPatternDetector precedent)', () => {
      const timeline = [
        makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts', agentId: 'agent-a' }),
        makeEntry({
          toolName: 'Bash',
          command: 'npm test',
          isTestCommand: true,
          success: false,
          agentId: 'agent-a',
        }),
        makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts', agentId: 'agent-b' }),
        makeEntry({
          toolName: 'Bash',
          command: 'npm test',
          isTestCommand: true,
          success: false,
          agentId: 'agent-b',
        }),
        makeEntry({ toolName: 'Edit', filePath: '/src/bug.ts', agentId: 'agent-c' }),
        makeEntry({
          toolName: 'Bash',
          command: 'npm test',
          isTestCommand: true,
          success: false,
          agentId: 'agent-c',
        }),
      ];
      const result = analyzeReplayTimeline(timeline);
      const thrash = result.segments.filter((s) => s.type === 'thrashing');
      expect(thrash).toHaveLength(1);
      expect(thrash[0]!.iterations).toBe(3);
      // Not agent-scoped — GanttTimeline must still highlight every row in
      // range for this type, regardless of which agent made each call.
      expect(thrash[0]!.agentScoped).toBeFalsy();
    });
  });

  describe('worstSegment', () => {
    it('selects stuck_loop with highest weighted score', () => {
      const timeline: ReplayTimelineEntry[] = [];
      // 3 blind edits (score: 3*1=3)
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Edit', filePath: '/src/a.ts' }));
      }
      // 3 stuck loops (score: 3*2=6, due to 2x weight)
      for (let i = 0; i < 3; i++) {
        timeline.push(makeEntry({ toolName: 'Bash', command: 'npm test', success: false }));
      }

      const result = analyzeReplayTimeline(timeline);
      expect(result.worstSegment).not.toBeNull();
      expect(result.worstSegment!.type).toBe('stuck_loop');
    });
  });
});
