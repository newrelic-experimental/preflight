import { createLogger } from '../shared/index.js';
import { ZERO_QUALITY_PROXY_COUNTS } from '../metrics/quality-proxy-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';

const logger = createLogger('homelab-accumulator');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const STALE_SESSION_MS = 3 * 60 * 1000;
const FLUSH_INTERVAL_MS = 60_000;

export interface HomelabIngestPayload {
  readonly developer: string;
  readonly sessionId: string;
  readonly records: ToolCallRecord[];
}

interface ActiveSession {
  readonly developer: string;
  readonly sessionId: string;
  records: ToolCallRecord[];
  readonly startTime: number;
  lastSeen: number;
}

function isIngestPayload(v: unknown): v is HomelabIngestPayload {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.developer === 'string' &&
    typeof obj.sessionId === 'string' &&
    Array.isArray(obj.records)
  );
}

export class HomelabAccumulator {
  private readonly sessionStore: SessionStore;
  private readonly sessions = new Map<string, ActiveSession>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { storagePath: string }) {
    this.sessionStore = new SessionStore({ storagePath: opts.storagePath });
  }

  handleIngest(payload: unknown): 'ok' | 'invalid' {
    if (!isIngestPayload(payload)) return 'invalid';
    const { developer, sessionId, records } = payload;
    if (!developer || !SESSION_ID_RE.test(sessionId)) return 'invalid';

    const key = `${developer}:${sessionId}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.records.push(...records);
      existing.lastSeen = Date.now();
    } else {
      this.sessions.set(key, {
        developer,
        sessionId,
        records: [...records],
        startTime: records[0]?.timestamp ?? Date.now(),
        lastSeen: Date.now(),
      });
    }
    return 'ok';
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flushStaleSessions(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAllSessions();
  }

  private flushStaleSessions(): void {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastSeen < cutoff) {
        this.saveSession(session);
        this.sessions.delete(key);
      }
    }
  }

  private flushAllSessions(): void {
    for (const session of this.sessions.values()) {
      this.saveSession(session);
    }
    this.sessions.clear();
  }

  private saveSession(session: ActiveSession): void {
    const summary = buildMinimalSummary(session);
    try {
      this.sessionStore.saveSession(summary);
    } catch (err) {
      logger.warn('Failed to save homelab session', {
        error: String(err),
        sessionId: session.sessionId,
      });
    }
  }
}

function buildMinimalSummary(session: ActiveSession): FullSessionSummary {
  const toolBreakdown: Record<string, number> = {};
  for (const r of session.records) {
    toolBreakdown[r.toolName] = (toolBreakdown[r.toolName] ?? 0) + 1;
  }

  const endTime = session.records.at(-1)?.timestamp ?? session.lastSeen;
  return {
    sessionId: session.sessionId,
    startTime: session.startTime,
    endTime,
    durationMs: endTime - session.startTime,
    toolCallCount: session.records.length,
    developer: session.developer,
    sessionName: null,
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    model: null,
    toolBreakdown,
    filesRead: [],
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandCount: 0,
    testRunCount: 0,
    testPassCount: 0,
    buildRunCount: 0,
    buildPassCount: 0,
    estimatedCostUsd: null,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: null,
    toolSelectionMetrics: null,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
    antiPatterns: [],
    taskCount: 0,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'unknown',
    platform: 'homelab',
  };
}
