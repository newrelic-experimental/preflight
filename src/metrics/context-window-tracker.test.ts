import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContextWindowTracker } from './context-window-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('ContextWindowTracker', () => {
  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'r1',
      sessionId: 's1',
      toolUseId: 'u1',
      toolName: 'Read',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
      filePath: '/src/app.ts',
      ...overrides,
    } as ToolCallRecord;
  }

  it('returns zeros for empty session', () => {
    const t = new ContextWindowTracker();
    const m = t.getMetrics();
    expect(m.totalReadOperations).toBe(0);
    expect(m.repeatedReadRatio).toBeNull();
  });

  it('counts unique reads with no repeats', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/b.ts' }));
    expect(t.getMetrics().uniqueFilesRead).toBe(2);
    expect(t.getMetrics().repeatedReadCount).toBe(0);
  });

  it('counts repeated reads', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    expect(t.getMetrics().repeatedReadCount).toBe(2);
  });

  it('ignores non-Read tool calls', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Bash', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('ignores Read calls without filePath', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('reset clears all state', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord());
    t.reset('new-session');
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('topRepeatedFiles returns up to 5 entries and caps at 5', () => {
    const t = new ContextWindowTracker();
    for (let i = 0; i < 6; i++) {
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
    }
    expect(t.getMetrics().topRepeatedFiles).toHaveLength(5);
  });

  it('topRepeatedFiles is sorted descending by readCount with correct top entries', () => {
    const t = new ContextWindowTracker();
    // file-a: 5 reads, file-b: 3 reads, file-c: 2 reads, file-d: 1 read (not repeated)
    for (let i = 0; i < 5; i++) t.recordToolCall(makeRecord({ filePath: '/file-a.ts' }));
    for (let i = 0; i < 3; i++) t.recordToolCall(makeRecord({ filePath: '/file-b.ts' }));
    for (let i = 0; i < 2; i++) t.recordToolCall(makeRecord({ filePath: '/file-c.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/file-d.ts' }));
    const top = t.getMetrics().topRepeatedFiles;
    expect(top[0]).toEqual({ file: '/file-a.ts', readCount: 5 });
    expect(top[1]).toEqual({ file: '/file-b.ts', readCount: 3 });
    expect(top[2]).toEqual({ file: '/file-c.ts', readCount: 2 });
    // file-d has no repeats so it must not appear
    expect(top.find((e) => e.file === '/file-d.ts')).toBeUndefined();
  });

  it('caps fileReadCounts at MAX_UNIQUE_FILES, evicting the earliest-read file first', () => {
    const t = new ContextWindowTracker();
    for (let i = 0; i < 10_001; i++) {
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
    }
    expect(t.getMetrics().uniqueFilesRead).toBe(10_000);

    // The very first file read should have been evicted to make room...
    t.recordToolCall(makeRecord({ filePath: '/file-0.ts' }));
    expect(t.getMetrics().uniqueFilesRead).toBe(10_000);

    // ...while the most recently read file is still tracked.
    t.recordToolCall(makeRecord({ filePath: '/file-10000.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/file-10000.ts' }));
    expect(t.getMetrics().topRepeatedFiles.some((e) => e.file === '/file-10000.ts')).toBe(true);
  });
});
