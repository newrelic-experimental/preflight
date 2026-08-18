import type { FullSessionSummary } from '../storage/session-store.js';
import type { TaskDetectorSeed } from './task-detector.js';

// Builds the seed a freshly-started process's TaskDetector needs to recover
// a resumed session's pre-restart file/line/test/build/agent-spawn totals —
// see TaskDetector.seedFromPersisted() for why this exists. Lives in its own
// file (not task-detector.ts) to avoid a circular import: session-store.ts
// already imports TaskDetector/TaskMetrics from task-detector.ts.
export function buildTaskDetectorSeed(persisted: FullSessionSummary): TaskDetectorSeed {
  return {
    filesRead: persisted.filesRead,
    filesModified: persisted.filesModified,
    linesAdded: persisted.linesAdded,
    linesRemoved: persisted.linesRemoved,
    testsRun: persisted.testRunCount,
    testsPassed: persisted.testPassCount,
    buildRun: persisted.buildRunCount,
    buildPassed: persisted.buildPassCount,
    agentSpawns: persisted.agentSpawns,
    taskCount: persisted.taskCount,
  };
}
