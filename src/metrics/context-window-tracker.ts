import type { ToolCallRecord } from '../storage/types.js';

export interface ContextWindowMetrics {
  readonly uniqueFilesRead: number;
  readonly totalReadOperations: number;
  readonly repeatedReadCount: number;
  readonly repeatedReadRatio: number | null;
  readonly topRepeatedFiles: ReadonlyArray<{ file: string; readCount: number }>;
}

// Bounds memory on sessions that touch an unusually large number of distinct
// files (e.g. a repo-wide codemod or search) — head-drop the oldest-read
// file once the cap is hit, matching EventBuffer's eviction policy.
const MAX_UNIQUE_FILES = 10_000;

export class ContextWindowTracker {
  private fileReadCounts = new Map<string, number>();

  recordToolCall(record: ToolCallRecord): void {
    if (record.toolName !== 'Read') return;
    const filePath = record.filePath as string | undefined;
    if (!filePath) return;
    const count = this.fileReadCounts.get(filePath) ?? 0;
    if (count === 0 && this.fileReadCounts.size >= MAX_UNIQUE_FILES) {
      const oldest = this.fileReadCounts.keys().next().value;
      if (oldest !== undefined) this.fileReadCounts.delete(oldest);
    }
    this.fileReadCounts.set(filePath, count + 1);
  }

  getMetrics(): ContextWindowMetrics {
    const entries = [...this.fileReadCounts.entries()];
    const totalReadOperations = entries.reduce((sum, [, c]) => sum + c, 0);
    const uniqueFilesRead = entries.length;
    const repeatedReadCount = entries.reduce((sum, [, c]) => sum + Math.max(0, c - 1), 0);
    const repeatedReadRatio =
      totalReadOperations > 0 ? repeatedReadCount / totalReadOperations : null;

    const topRepeatedFiles = entries
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, readCount]) => ({ file, readCount }));

    return {
      uniqueFilesRead,
      totalReadOperations,
      repeatedReadCount,
      repeatedReadRatio,
      topRepeatedFiles,
    };
  }

  reset(_sessionId: string): void {
    this.fileReadCounts.clear();
  }
}
