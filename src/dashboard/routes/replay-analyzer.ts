import type { ReplayTimelineEntry } from '../../storage/types.js';
import { partitionByAgent } from '../../metrics/agent-partition.js';

// Pairs an entry with its position in the original flat `timeline` array.
// `stuck_loop`/`blind_editing`/`re_reading` run per agent-group (see
// `analyzeReplayTimeline`), but `AntiPatternSegment.startIndex`/`endIndex`
// must still reference the original flat array — that's what
// `GanttTimeline.tsx` uses to place the overlay — so each detector below
// reads `index` from this wrapper instead of its own sub-array position.
interface IndexedEntry {
  readonly entry: ReplayTimelineEntry;
  readonly index: number;
  readonly agentId?: string;
}

export interface AntiPatternSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly iterations: number;
  readonly target: string;
  readonly severity: 'warning' | 'critical';
}

export interface ReplayAnalysis {
  readonly segments: AntiPatternSegment[];
  readonly worstSegment: AntiPatternSegment | null;
}

const THRASH_THRESHOLD = 3;
const STUCK_LOOP_THRESHOLD = 3;
const BLIND_EDIT_THRESHOLD = 3;
const RE_READ_THRESHOLD = 4;
const CRITICAL_THRESHOLD = 5;

export function analyzeReplayTimeline(timeline: ReplayTimelineEntry[]): ReplayAnalysis {
  const segments: AntiPatternSegment[] = [];

  // Thrashing runs over the whole flat sequence, unpartitioned — its
  // `lastEditFile` trigger is a single scalar shared across agents, and a
  // false positive still requires the same file to cycle through
  // edit/test-fail more than once, a narrower risk than the detectors below.
  // Mirrors the same left-unpartitioned decision `AntiPatternDetector` made
  // for #607 (see src/metrics/anti-patterns.ts).
  segments.push(...detectThrashingSegments(timeline));

  // Stuck-loop, blind-editing, and re-reading all detect one agent repeating
  // itself over a timestamp-ordered sequence. Run each per agent (parent
  // session + one group per distinct subagent `agentId`) so parallel
  // subagents each independently doing something once don't look like a
  // single agent repeating itself (#625).
  const indexed: IndexedEntry[] = timeline.map((entry, index) => ({
    entry,
    index,
    agentId: entry.agentId,
  }));
  for (const group of partitionByAgent(indexed)) {
    segments.push(...detectStuckLoopSegments(group));
    segments.push(...detectBlindEditSegments(group));
    segments.push(...detectReReadingSegments(group));
  }

  let worstSegment: AntiPatternSegment | null = null;
  let worstScore = 0;
  for (const seg of segments) {
    const score = seg.iterations * (seg.type === 'stuck_loop' ? 2 : 1);
    if (score > worstScore) {
      worstScore = score;
      worstSegment = seg;
    }
  }

  return { segments, worstSegment };
}

function severity(iterations: number): 'warning' | 'critical' {
  return iterations >= CRITICAL_THRESHOLD ? 'critical' : 'warning';
}

function detectThrashingSegments(timeline: ReplayTimelineEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  let lastEditFile: string | null = null;
  let lastEditIndex = -1;
  let cycleStartIndex = -1;
  let cycleCount = 0;
  let cycleFile: string | null = null;

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];

    if ((entry.toolName === 'Edit' || entry.toolName === 'Write') && entry.filePath) {
      if (entry.filePath !== lastEditFile) {
        if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
          segments.push({
            type: 'thrashing',
            startIndex: cycleStartIndex,
            endIndex: i - 1,
            iterations: cycleCount,
            target: cycleFile,
            severity: severity(cycleCount),
          });
        }
        cycleCount = 0;
        cycleStartIndex = i;
        cycleFile = entry.filePath;
      }
      lastEditFile = entry.filePath;
      lastEditIndex = i;
    } else if (entry.toolName === 'Bash' && entry.isTestCommand && lastEditFile !== null) {
      if (!entry.success) {
        cycleCount++;
        if (cycleStartIndex === -1) cycleStartIndex = lastEditIndex;
      } else {
        if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
          segments.push({
            type: 'thrashing',
            startIndex: cycleStartIndex,
            endIndex: i,
            iterations: cycleCount,
            target: cycleFile,
            severity: severity(cycleCount),
          });
        }
        cycleCount = 0;
        cycleStartIndex = i + 1;
      }
    }
  }

  if (cycleFile && cycleCount >= THRASH_THRESHOLD) {
    segments.push({
      type: 'thrashing',
      startIndex: cycleStartIndex,
      endIndex: timeline.length - 1,
      iterations: cycleCount,
      target: cycleFile,
      severity: severity(cycleCount),
    });
  }

  return segments;
}

function detectStuckLoopSegments(group: readonly IndexedEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  let lastCommand: string | null = null;
  let runStartIndex = -1;
  let lastMatchIndex = -1;
  let consecutiveCount = 0;

  for (const { entry, index } of group) {
    if (entry.toolName === 'Bash' && entry.command != null) {
      if (entry.command === lastCommand) {
        consecutiveCount++;
      } else {
        if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
          segments.push({
            type: 'stuck_loop',
            startIndex: runStartIndex,
            endIndex: lastMatchIndex,
            iterations: consecutiveCount,
            target: lastCommand,
            severity: severity(consecutiveCount),
          });
        }
        lastCommand = entry.command;
        runStartIndex = index;
        consecutiveCount = 1;
      }
      lastMatchIndex = index;
    } else {
      if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
        segments.push({
          type: 'stuck_loop',
          startIndex: runStartIndex,
          endIndex: lastMatchIndex,
          iterations: consecutiveCount,
          target: lastCommand,
          severity: severity(consecutiveCount),
        });
      }
      lastCommand = null;
      consecutiveCount = 0;
    }
  }

  if (lastCommand && consecutiveCount >= STUCK_LOOP_THRESHOLD) {
    segments.push({
      type: 'stuck_loop',
      startIndex: runStartIndex,
      endIndex: lastMatchIndex,
      iterations: consecutiveCount,
      target: lastCommand,
      severity: severity(consecutiveCount),
    });
  }

  return segments;
}

function detectBlindEditSegments(group: readonly IndexedEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  const streaks = new Map<string, { start: number; count: number; lastIndex: number }>();

  for (const { entry, index } of group) {
    if ((entry.toolName === 'Edit' || entry.toolName === 'Write') && entry.filePath) {
      const existing = streaks.get(entry.filePath);
      if (existing) {
        existing.count++;
        existing.lastIndex = index;
      } else {
        streaks.set(entry.filePath, { start: index, count: 1, lastIndex: index });
      }
    } else if (entry.toolName === 'Read' && entry.filePath) {
      const streak = streaks.get(entry.filePath);
      if (streak && streak.count >= BLIND_EDIT_THRESHOLD) {
        segments.push({
          type: 'blind_editing',
          startIndex: streak.start,
          endIndex: streak.lastIndex,
          iterations: streak.count,
          target: entry.filePath,
          severity: severity(streak.count),
        });
      }
      streaks.delete(entry.filePath);
    } else if (
      entry.toolName === 'Bash' &&
      (entry.isTestCommand || entry.isBuildCommand || entry.isLintCommand) &&
      entry.success
    ) {
      for (const [file, streak] of streaks) {
        if (streak.count >= BLIND_EDIT_THRESHOLD) {
          segments.push({
            type: 'blind_editing',
            startIndex: streak.start,
            endIndex: streak.lastIndex,
            iterations: streak.count,
            target: file,
            severity: severity(streak.count),
          });
        }
      }
      streaks.clear();
    }
  }

  for (const [file, streak] of streaks) {
    if (streak.count >= BLIND_EDIT_THRESHOLD) {
      segments.push({
        type: 'blind_editing',
        startIndex: streak.start,
        endIndex: streak.lastIndex,
        iterations: streak.count,
        target: file,
        severity: severity(streak.count),
      });
    }
  }

  return segments;
}

function detectReReadingSegments(group: readonly IndexedEntry[]): AntiPatternSegment[] {
  const segments: AntiPatternSegment[] = [];
  const reads = new Map<string, number[]>();

  for (const { entry, index } of group) {
    if (entry.toolName === 'Read' && entry.filePath) {
      const indices = reads.get(entry.filePath) ?? [];
      indices.push(index);
      reads.set(entry.filePath, indices);
    }
  }

  for (const [file, indices] of reads) {
    if (indices.length >= RE_READ_THRESHOLD) {
      segments.push({
        type: 're_reading',
        startIndex: indices[0],
        endIndex: indices[indices.length - 1],
        iterations: indices.length,
        target: file,
        severity: severity(indices.length),
      });
    }
  }

  return segments;
}
