/**
 * Deterministic demo dataset for `preflight demo`.
 *
 * Every session is generated as a tool-call timeline first; all aggregate
 * fields (counts, tokens, cost, quality signals, attribution, audit records)
 * are derived from that one timeline so every dashboard panel agrees with
 * every other. Dates are relative to `now` and the PRNG is fixed-seed, so a
 * rehearsal and the live demo show the same story.
 */

import { calculateCost } from '../shared/index.js';
import { localDateKey, localStartOfDay } from '../lib/date.js';
import type { AlertEvent } from '../dashboard/live-event-bus.js';
import type { ModelBreakdownEntry } from '../metrics/model-usage-tracker.js';
import type { AntiPatternType } from '../metrics/anti-patterns.js';
import type { FullSessionSummary, PersistedAntiPattern } from '../storage/session-store.js';
import type {
  AttributionBucket,
  AuditEntry,
  ReplayTimelineEntry,
  SessionAttribution,
} from '../storage/types.js';
import { HIGH_CONTEXT_TOKENS } from '../storage/types.js';

export const DEMO_DEVELOPER = 'demo';

const HISTORY_DAYS = 30;
const SUBAGENT_MODEL = 'claude-haiku-5-5';

interface Phase {
  readonly tool: 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'Bash' | 'Agent' | 'Skill';
  readonly min: number;
  readonly max: number;
  readonly failRate?: number;
  readonly commands?: readonly string[];
  readonly files?: readonly string[];
  readonly kind?: 'test' | 'build';
  readonly agentType?: string;
  readonly skillName?: string;
  /** Hit the same file every time, which is what the re-reading detector flags. */
  readonly sameFile?: boolean;
}

type DemoAntiPattern = Extract<AntiPatternType, 'thrashing' | 're_reading' | 'over_delegation'>;

interface Archetype {
  readonly titles: readonly string[];
  readonly phases: readonly Phase[];
  readonly efficiency: number;
  readonly antiPattern?: DemoAntiPattern;
  readonly abandonRate?: number;
}

const TEST = ['npm test', 'npx jest src/checkout', 'pytest -q', 'go test ./...'];
const BUILD = ['npm run build', 'tsc --noEmit', 'docker build .'];

const ARCHETYPES = {
  feature: {
    titles: [
      'Add retry to webhook delivery',
      'Support saved payment methods',
      'Add CSV export to reports',
    ],
    phases: [
      { tool: 'Glob', min: 1, max: 2 },
      { tool: 'Read', min: 4, max: 8 },
      { tool: 'Grep', min: 2, max: 4 },
      { tool: 'Edit', min: 5, max: 9 },
      { tool: 'Write', min: 1, max: 2 },
      { tool: 'Bash', min: 2, max: 4, failRate: 0.35, commands: TEST, kind: 'test' },
      { tool: 'Edit', min: 1, max: 3 },
      { tool: 'Bash', min: 1, max: 1, commands: TEST, kind: 'test' },
    ],
    efficiency: 84,
  },
  bugfix: {
    titles: ['Fix double-charge on retry', 'Fix flaky session timeout test', 'Fix null cart total'],
    phases: [
      { tool: 'Grep', min: 3, max: 6 },
      { tool: 'Read', min: 3, max: 6 },
      { tool: 'Agent', min: 1, max: 1, agentType: 'Explore' },
      { tool: 'Edit', min: 2, max: 4 },
      { tool: 'Bash', min: 2, max: 3, failRate: 0.2, commands: TEST, kind: 'test' },
    ],
    efficiency: 88,
  },
  refactor: {
    titles: ['Extract pricing module', 'Migrate config loader to zod', 'Split order service'],
    phases: [
      { tool: 'Read', min: 6, max: 12 },
      { tool: 'Edit', min: 8, max: 14 },
      { tool: 'Bash', min: 1, max: 2, failRate: 0.25, commands: BUILD, kind: 'build' },
      { tool: 'Bash', min: 2, max: 3, failRate: 0.15, commands: TEST, kind: 'test' },
    ],
    efficiency: 79,
  },
  review: {
    titles: ['Review PR: inventory sync', 'Review PR: auth token refresh'],
    phases: [
      { tool: 'Skill', min: 1, max: 1, skillName: 'code-review' },
      { tool: 'Bash', min: 1, max: 2, commands: ['gh pr diff', 'gh pr view --comments'] },
      { tool: 'Read', min: 4, max: 8 },
      { tool: 'Grep', min: 1, max: 3 },
    ],
    efficiency: 91,
  },
  thrash: {
    titles: ['Fix failing integration tests', 'Get CI green on payments branch'],
    phases: [
      { tool: 'Read', min: 2, max: 3 },
      { tool: 'Edit', min: 6, max: 9, sameFile: true },
      {
        tool: 'Bash',
        min: 6,
        max: 9,
        failRate: 0.75,
        commands: ['npm test -- integration'],
        kind: 'test',
      },
    ],
    efficiency: 46,
    antiPattern: 'thrashing',
    abandonRate: 0.4,
  },
  explore: {
    titles: ['Understand the ledger reconciliation flow', 'Map the notification pipeline'],
    phases: [
      { tool: 'Grep', min: 4, max: 8 },
      { tool: 'Read', min: 10, max: 16, sameFile: true },
      {
        tool: 'Bash',
        min: 1,
        max: 2,
        commands: ['git log --oneline -20', 'curl https://api.github.com/repos'],
      },
    ],
    efficiency: 63,
    antiPattern: 're_reading',
  },
  fanout: {
    titles: ['Audit dependencies across services', 'Survey error handling patterns'],
    phases: [
      { tool: 'Agent', min: 5, max: 7, agentType: 'general-purpose' },
      { tool: 'Read', min: 2, max: 4 },
      { tool: 'Write', min: 1, max: 1 },
    ],
    efficiency: 68,
    antiPattern: 'over_delegation',
  },
  cleanup: {
    titles: ['Remove dead feature flags', 'Clean up build artifacts'],
    phases: [
      { tool: 'Grep', min: 2, max: 4 },
      { tool: 'Bash', min: 1, max: 1, commands: ['rm -rf dist/legacy'] },
      { tool: 'Read', min: 1, max: 3, files: ['.env'] },
      { tool: 'Edit', min: 3, max: 6 },
      { tool: 'Bash', min: 1, max: 2, commands: TEST, kind: 'test' },
    ],
    efficiency: 82,
  },
} as const satisfies Record<string, Archetype>;

type ArchetypeName = keyof typeof ARCHETYPES;

const REPOS = [
  'checkout-service',
  'web-storefront',
  'payments-api',
  'mobile-app',
  'infra-terraform',
];
const FILES = [
  'src/index.ts',
  'src/handlers/webhook.ts',
  'src/services/order.ts',
  'src/lib/pricing.ts',
  'src/db/ledger.ts',
  'test/integration/checkout.test.ts',
  'README.md',
  'package.json',
];
const MODELS = [
  { id: 'claude-sonnet-5-5', weight: 0.55 },
  { id: 'claude-opus-5-5', weight: 0.3 },
  { id: 'claude-haiku-5-5', weight: 0.15 },
];
const PLATFORMS = [
  { id: 'claude-code', weight: 0.7 },
  { id: 'cursor', weight: 0.2 },
  { id: 'copilot', weight: 0.1 },
];
const TOOL_MS: Record<Phase['tool'], readonly [number, number]> = {
  Read: [30, 200],
  Grep: [100, 600],
  Glob: [40, 150],
  Edit: [50, 300],
  Write: [60, 250],
  Bash: [800, 6_000],
  Agent: [30_000, 150_000],
  Skill: [2_000, 9_000],
};

/** Today's curated lineup: healthy work, one thrash, one fan-out, one flagged cleanup. */
const TODAY: readonly { archetype: ArchetypeName; model: string; platform: string }[] = [
  { archetype: 'feature', model: 'claude-opus-5-5', platform: 'claude-code' },
  { archetype: 'review', model: 'claude-sonnet-5-5', platform: 'claude-code' },
  { archetype: 'thrash', model: 'claude-sonnet-5-5', platform: 'cursor' },
  { archetype: 'bugfix', model: 'claude-sonnet-5-5', platform: 'claude-code' },
  { archetype: 'fanout', model: 'claude-opus-5-5', platform: 'claude-code' },
  { archetype: 'cleanup', model: 'claude-haiku-5-5', platform: 'copilot' },
];

export interface DemoData {
  readonly sessions: FullSessionSummary[];
  readonly auditEntries: AuditEntry[];
  readonly alerts: AlertEvent[];
}

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const weighted = (rng: Rng, items: readonly { id: string; weight: number }[]): string => {
  let r = rng();
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.id;
  }
  return items[items.length - 1]!.id;
};
const uuid = (rng: Rng) =>
  [8, 4, 4, 4, 12]
    .map((n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join(''))
    .join('-');
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function priced(model: string, u: Usage) {
  const totalTokens =
    u.inputTokens + u.outputTokens + u.thinkingTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return calculateCost(model, { ...u, totalTokens });
}

function addUsage(
  acc: Record<string, ModelBreakdownEntry>,
  model: string,
  u: Usage,
  costUsd: number,
) {
  const prev = acc[model];
  acc[model] = {
    requestCount: (prev?.requestCount ?? 0) + 1,
    totalInputTokens: (prev?.totalInputTokens ?? 0) + u.inputTokens,
    totalOutputTokens: (prev?.totalOutputTokens ?? 0) + u.outputTokens,
    totalCostUsd: (prev?.totalCostUsd ?? 0) + costUsd,
    totalCacheReadTokens: (prev?.totalCacheReadTokens ?? 0) + u.cacheReadTokens,
    totalCacheCreationTokens: (prev?.totalCacheCreationTokens ?? 0) + u.cacheCreationTokens,
    totalThinkingTokens: (prev?.totalThinkingTokens ?? 0) + u.thinkingTokens,
  };
}

function addBucket(
  facet: Record<string, AttributionBucket>,
  key: string,
  costUsd: number,
  tokens: number,
  durationMs: number,
) {
  const prev = facet[key];
  facet[key] = {
    costUsd: (prev?.costUsd ?? 0) + costUsd,
    tokens: (prev?.tokens ?? 0) + tokens,
    count: (prev?.count ?? 0) + 1,
    durationMs: (prev?.durationMs ?? 0) + durationMs,
  };
}

interface Generated {
  readonly session: FullSessionSummary;
  readonly audit: AuditEntry[];
}

function billableTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

function buildSession(
  rng: Rng,
  archetypeName: ArchetypeName,
  startTime: number,
  model: string,
  platform: string,
  trend: number,
): Generated {
  const archetype: Archetype = ARCHETYPES[archetypeName];
  const sessionId = uuid(rng);
  const repoName = pick(rng, REPOS);
  const stuckFile = pick(rng, FILES);

  const timeline: ReplayTimelineEntry[] = [];
  const audit: AuditEntry[] = [];
  const modelBreakdown: Record<string, ModelBreakdownEntry> = {};
  const toolBuckets: Record<string, AttributionBucket> = {};
  const skillBuckets: Record<string, AttributionBucket> = {};
  const subagentBuckets: Record<string, AttributionBucket> = {};
  const totals: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let costUsd = 0;
  let subagentCostUsd = 0;
  let cacheSavingsUsd = 0;
  let highContextCostUsd = 0;
  let apiDurationMs = 0;
  let contextCompressions = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let context = int(rng, 30_000, 45_000);
  let ts = startTime;

  const charge = (chargedModel: string, usage: Usage) => {
    const cost = priced(chargedModel, usage);
    costUsd += cost.totalUsd;
    cacheSavingsUsd += cost.savingsFromCacheUsd;
    for (const k of Object.keys(totals) as (keyof Usage)[]) totals[k] += usage[k];
    addUsage(modelBreakdown, chargedModel, usage, cost.totalUsd);
    return cost.totalUsd;
  };

  for (const phase of archetype.phases) {
    const n = int(rng, phase.min, phase.max);
    for (let i = 0; i < n; i++) {
      const think = int(rng, 3_000, 22_000);
      ts += think;
      apiDurationMs += think;

      const usage: Usage = {
        inputTokens: int(rng, 600, 3_000),
        outputTokens: int(rng, 150, 1_400),
        thinkingTokens: model.includes('opus') ? int(rng, 200, 1_500) : 0,
        cacheReadTokens: Math.round(context * 0.92),
        cacheCreationTokens: int(rng, 800, 4_000),
      };
      const cost = charge(model, usage);
      if (billableTokens(usage) - usage.outputTokens > HIGH_CONTEXT_TOKENS) {
        highContextCostUsd += cost;
      }

      context += int(rng, 1_500, 6_000);
      if (context > 170_000) {
        context = int(rng, 30_000, 45_000);
        contextCompressions++;
      }

      const [lo, hi] = TOOL_MS[phase.tool];
      let durationMs = int(rng, lo, hi);
      if (phase.kind === 'test') durationMs *= 6;
      if (phase.kind === 'build') durationMs *= 8;
      const success = rng() >= (phase.failRate ?? 0.02);
      const filePath = !['Read', 'Edit', 'Write'].includes(phase.tool)
        ? undefined
        : phase.sameFile
          ? stuckFile
          : pick(rng, phase.files ?? FILES);
      const command = phase.tool === 'Bash' ? pick(rng, phase.commands ?? TEST) : undefined;

      const entry: ReplayTimelineEntry = {
        timestamp: ts,
        toolName: phase.tool,
        durationMs,
        success,
        ...(filePath !== undefined && { filePath }),
        ...(command !== undefined && { command }),
        ...(phase.kind === 'test' && { isTestCommand: true }),
        ...(phase.kind === 'build' && { isBuildCommand: true }),
        ...(!success && { errorType: phase.kind === 'test' ? 'test_failure' : 'tool_error' }),
        ...(phase.agentType !== undefined && { agentType: phase.agentType }),
        ...(phase.skillName !== undefined && { skillName: phase.skillName }),
      };
      timeline.push(entry);
      addBucket(toolBuckets, phase.tool, cost, billableTokens(usage), durationMs);
      if (phase.skillName) {
        addBucket(skillBuckets, phase.skillName, cost, billableTokens(usage), durationMs);
      }
      if ((phase.tool === 'Edit' || phase.tool === 'Write') && success) {
        linesAdded += int(rng, 3, 45);
        linesRemoved += int(rng, 0, 18);
      }

      if (phase.tool === 'Agent' && phase.agentType) {
        const requests = int(rng, 6, 16);
        for (let r = 0; r < requests; r++) {
          const subUsage: Usage = {
            inputTokens: int(rng, 1_000, 4_000),
            outputTokens: int(rng, 200, 900),
            thinkingTokens: 0,
            cacheReadTokens: int(rng, 12_000, 40_000),
            cacheCreationTokens: int(rng, 1_000, 5_000),
          };
          const subCost = charge(SUBAGENT_MODEL, subUsage);
          subagentCostUsd += subCost;
          addBucket(subagentBuckets, phase.agentType, subCost, billableTokens(subUsage), 0);
        }
      }

      audit.push(auditEntry(rng, entry, sessionId));
      ts += durationMs;
    }
  }

  const endTime = ts + int(rng, 5_000, 30_000);
  const toolBreakdown: Record<string, number> = {};
  const skillBreakdown: Record<string, number> = {};
  for (const e of timeline) {
    toolBreakdown[e.toolName] = (toolBreakdown[e.toolName] ?? 0) + 1;
    if (e.skillName) skillBreakdown[e.skillName] = (skillBreakdown[e.skillName] ?? 0) + 1;
  }
  const passFail = (match: (e: ReplayTimelineEntry) => boolean) => {
    const hits = timeline.filter(match);
    const pass = hits.filter((e) => e.success).length;
    return { pass, fail: hits.length - pass };
  };
  const edits = passFail((e) => e.toolName === 'Edit' || e.toolName === 'Write');
  const tests = passFail((e) => e.isTestCommand === true);
  const builds = passFail((e) => e.isBuildCommand === true);
  const repeatedFailures = timeline.filter(
    (e, i) => i > 0 && !e.success && !timeline[i - 1]!.success,
  ).length;
  const filesWhere = (tools: readonly string[]) => [
    ...new Set(timeline.filter((e) => tools.includes(e.toolName)).map((e) => e.filePath!)),
  ];
  const successRate = round(timeline.filter((e) => e.success).length / timeline.length, 3);
  const dayKey = localDateKey(startTime);

  const outcome = rng() < (archetype.abandonRate ?? 0.03) ? 'abandoned' : 'completed';
  const taskCount = int(rng, 1, 3);
  const efficiencyPct = Math.max(
    25,
    Math.min(97, Math.round(archetype.efficiency + trend + (rng() - 0.5) * 10)),
  );
  const redundantReadCount =
    archetype.antiPattern === 're_reading' ? int(rng, 6, 10) : int(rng, 0, 2);
  const unusedOutputCount = int(rng, 0, 3);
  const penalizedCalls = Math.min(
    timeline.length,
    redundantReadCount + repeatedFailures + unusedOutputCount,
  );
  const backtrackCount = archetype.antiPattern === 'thrashing' ? int(rng, 3, 6) : int(rng, 0, 1);
  const selfCorrectionCount = int(rng, 0, 2);
  const userCorrections = archetype.antiPattern === 'thrashing' ? int(rng, 3, 5) : int(rng, 0, 1);

  const session: FullSessionSummary = {
    sessionId,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    toolCallCount: timeline.length,
    developer: DEMO_DEVELOPER,
    sessionName: pick(rng, archetype.titles),
    sessionNameSource: 'ai-title',
    sessionIntent: null,
    repoName,
    model,
    platform,
    toolBreakdown,
    skillBreakdown,
    filesRead: filesWhere(['Read']),
    filesModified: filesWhere(['Edit', 'Write']),
    linesAdded,
    linesRemoved,
    bashCommandCount: toolBreakdown.Bash ?? 0,
    testRunCount: tests.pass + tests.fail,
    testPassCount: tests.pass,
    buildRunCount: builds.pass + builds.fail,
    buildPassCount: builds.pass,
    estimatedCostUsd: round(costUsd),
    subagentCostUsd: round(subagentCostUsd),
    costByDayUsd: { [dayKey]: round(costUsd) },
    subagentCostByDayUsd: { [dayKey]: round(subagentCostUsd) },
    tokensInput: totals.inputTokens,
    tokensOutput: totals.outputTokens,
    tokensThinking: totals.thinkingTokens,
    tokensCacheRead: totals.cacheReadTokens,
    tokensCacheCreation: totals.cacheCreationTokens,
    cacheSavingsUsd: round(cacheSavingsUsd),
    efficiencyScore: efficiencyPct / 100,
    efficiencyScoreSampleCount: taskCount,
    efficiencyScoreComponents: {
      speed: Math.min(100, efficiencyPct + int(rng, -8, 8)) / 100,
      correctness: successRate,
      autonomy: Math.max(0, 100 - userCorrections * 15) / 100,
      firstAttemptQuality: Math.max(0, efficiencyPct - repeatedFailures * 5) / 100,
    },
    antiPatterns: archetype.antiPattern
      ? [antiPattern(archetype.antiPattern, stuckFile, tests.fail, edits, toolBreakdown)]
      : [],
    taskCount,
    taskSuccessRate: outcome === 'completed' ? 1 : 0,
    toolSuccessRate: successRate,
    contextCompressions,
    agentSpawns: toolBreakdown.Agent ?? 0,
    userMessages: int(rng, 3, 12),
    assistantMessages: timeline.length,
    userCorrections,
    outcome,
    instructionPromptHash: null,
    timeline,
    toolSelectionMetrics: {
      score: round(1 - penalizedCalls / timeline.length, 3),
      totalCalls: timeline.length,
      penalizedCalls,
      redundantReadCount,
      repeatedFailureCount: repeatedFailures,
      unusedOutputCount,
    },
    modelBreakdown,
    attribution: {
      buckets: { tool: toolBuckets, skill: skillBuckets, subagent: subagentBuckets },
      highContextCostUsd: round(highContextCostUsd),
      apiDurationMs,
    } satisfies SessionAttribution,
    costByWorkflowRunId: {},
    qualityProxy: {
      totalSignals:
        edits.pass + edits.fail + tests.pass + tests.fail + backtrackCount + selfCorrectionCount,
      diffApplyCleanCount: edits.pass,
      diffFailCount: edits.fail,
      testPassCount: tests.pass,
      testFailCount: tests.fail,
      backtrackCount,
      selfCorrectionCount,
    },
  };
  return { session, audit };
}

function antiPattern(
  type: DemoAntiPattern,
  file: string,
  failedTests: number,
  edits: { pass: number; fail: number },
  toolBreakdown: Record<string, number>,
): PersistedAntiPattern {
  switch (type) {
    case 'thrashing':
      return { type, file, iterations: failedTests, editCount: edits.pass + edits.fail };
    case 're_reading':
      return { type, file, readCount: toolBreakdown.Read ?? 0 };
    case 'over_delegation':
      return { type, agentCount: toolBreakdown.Agent ?? 0 };
  }
}

const AUDIT_ACTION: Record<string, string> = {
  Read: 'FileRead',
  Grep: 'FileRead',
  Glob: 'FileRead',
  Edit: 'FileEdit',
  Write: 'FileWrite',
  Bash: 'BashCommand',
  Agent: 'AgentSpawn',
  Skill: 'McpToolCall',
};

function auditEntry(rng: Rng, e: ReplayTimelineEntry, sessionId: string): AuditEntry {
  const detail = e.command ?? e.filePath ?? e.agentType ?? e.skillName ?? e.toolName;
  const securityAlert = e.command?.startsWith('rm -rf')
    ? { alertType: 'destructive_command', severity: 'critical' }
    : e.filePath === '.env'
      ? { alertType: 'sensitive_file', severity: 'high' }
      : e.command?.startsWith('curl')
        ? { alertType: 'external_network', severity: 'medium' }
        : undefined;
  return {
    id: uuid(rng),
    timestamp: e.timestamp,
    sessionId,
    tool: e.toolName,
    detail,
    action: AUDIT_ACTION[e.toolName] ?? 'McpToolCall',
    developer: DEMO_DEVELOPER,
    ...(e.filePath !== undefined && { filePath: e.filePath }),
    ...(e.command !== undefined && { command: e.command }),
    ...(securityAlert && { securityAlert }),
  };
}

const HEALTHY: readonly ArchetypeName[] = [
  'feature',
  'feature',
  'bugfix',
  'bugfix',
  'refactor',
  'review',
  'cleanup',
];
const WASTEFUL: readonly ArchetypeName[] = ['thrash', 'explore', 'fanout'];

export function buildDemoData(now: Date = new Date()): DemoData {
  const nowMs = now.getTime();
  const startOfToday = localStartOfDay(nowMs);
  const generated: Generated[] = [];

  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 1; daysAgo--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const dayStart = day.getTime();
    // Seeded by calendar date, so a given day replays identically whenever the demo runs.
    const rng = mulberry32(day.getFullYear() * 10_000 + (day.getMonth() + 1) * 100 + day.getDate());
    const weekday = day.getDay() % 6 !== 0;
    const n = weekday ? int(rng, 2, 5) : int(rng, 0, 1);
    // Wasteful sessions get rarer toward today, so the trend charts show a team improving.
    const wasteRate = 0.15 + 0.3 * (daysAgo / HISTORY_DAYS);
    const trend = -6 * (daysAgo / HISTORY_DAYS);
    for (let i = 0; i < n; i++) {
      const start = dayStart + int(rng, 9, 17) * 3_600_000 + int(rng, 0, 59) * 60_000;
      const archetype = pick(rng, rng() < wasteRate ? WASTEFUL : HEALTHY);
      generated.push(
        buildSession(rng, archetype, start, weighted(rng, MODELS), weighted(rng, PLATFORMS), trend),
      );
    }
  }

  // Today's sessions all end before `now`, spaced back from it. Their own seed keeps
  // them identical from a rehearsal to the live demo on another day.
  const rng = mulberry32(0x9e3779b9);
  const gap = Math.max(25 * 60_000, Math.round((nowMs - startOfToday) / (TODAY.length + 1)));
  TODAY.forEach((t, i) => {
    const start = nowMs - (TODAY.length - i) * gap;
    generated.push(buildSession(rng, t.archetype, start, t.model, t.platform, 4));
  });

  const sessions = generated.map((g) => g.session);
  const todaySessions = sessions.slice(-TODAY.length);
  const todayOf = (archetype: ArchetypeName) =>
    todaySessions[TODAY.findIndex((t) => t.archetype === archetype)]!;
  const thrashSession = todayOf('thrash');
  const failedRuns = thrashSession.testRunCount - thrashSession.testPassCount;
  const costs = sessions.map((s) => s.estimatedCostUsd ?? 0).sort((a, b) => a - b);
  const medianCost = costs[Math.floor(costs.length / 2)]!;
  const priciest = todaySessions.reduce((a, b) =>
    (b.estimatedCostUsd ?? 0) > (a.estimatedCostUsd ?? 0) ? b : a,
  );
  const priciestCost = priciest.estimatedCostUsd ?? 0;
  const alerts: AlertEvent[] = [
    {
      id: 'demo-thrashing',
      state: 'firing',
      severity: 'warning',
      title: 'Thrashing detected',
      description: `"${thrashSession.sessionName}" ran the same failing test ${failedRuns} times`,
      value: failedRuns,
      threshold: 4,
      firedAt: thrashSession.endTime,
    },
    {
      id: 'demo-cost-spike',
      state: 'firing',
      severity: 'info',
      title: 'Session cost spike',
      description: `"${priciest.sessionName}" cost $${priciestCost.toFixed(2)}, ${(priciestCost / medianCost).toFixed(1)}x the 30-day median`,
      value: round(priciestCost, 2),
      threshold: round(medianCost * 2, 2),
      firedAt: priciest.endTime,
    },
    {
      id: 'demo-destructive',
      state: 'cleared',
      severity: 'critical',
      title: 'Destructive command',
      description: 'rm -rf dist/legacy ran in a Copilot session',
      value: 1,
      threshold: 1,
      firedAt: todayOf('cleanup').startTime,
    },
  ];

  return {
    sessions,
    auditEntries: generated.flatMap((g) => g.audit),
    alerts,
  };
}
