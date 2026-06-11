import { resolveModelPricing } from '../shared/index.js';
import type { TokenEvent, ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextBreakdown {
  readonly system: number;
  readonly tools: number;
  readonly user: number;
  readonly assistant: number;
}

export interface ContextTurnSnapshot {
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly fillPercent: number;
  readonly breakdown: ContextBreakdown;
}

export interface ContextGrowthSummary {
  readonly startTokens: number;
  readonly currentTokens: number;
  readonly deltaTokens: number;
}

export interface ToolContextContribution {
  readonly tool: string;
  readonly totalBytes: number;
  readonly estimatedTokens: number;
  readonly percentOfToolOutput: number;
}

export interface ContextTrackerMetrics {
  readonly turnCount: number;
  readonly growth: ContextGrowthSummary;
  readonly currentBreakdown: ContextBreakdown;
  readonly fillPercent: number;
  readonly contextWindow: number;
  readonly toolContributions: readonly ToolContextContribution[];
  readonly history: readonly ContextTurnSnapshot[];
}

export interface ContextTrackerOptions {
  readonly modelContextWindow?: number;
  readonly maxHistorySize?: number;
  readonly bytesPerToken?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_HISTORY = 500;
const DEFAULT_BYTES_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// ContextTracker
// ---------------------------------------------------------------------------

export class ContextTracker {
  // Initial cap from the constructor option (or default). Each recorded turn
  // can refine this via the model name in the TokenEvent — e.g. claude-opus-4-7
  // is a 1M-token window; without the lookup the bar would read 100% at 200K.
  // Invariant: this value is monotonically non-decreasing within a session
  // (max-only update, never shrink). A mid-session sub-agent dispatch to a
  // smaller model must not collapse the cap, because cached history is still
  // indexed against the larger context window.
  private modelContextWindow: number;
  private readonly maxHistorySize: number;
  private readonly bytesPerToken: number;

  private turnCount = 0;
  private firstTurnInputTokens = 0;
  private currentInputTokens = 0;
  private systemBaseline = 0;
  private cumulativeAssistantTokens = 0;
  private readonly toolOutputBytes = new Map<string, number>();
  private readonly history: ContextTurnSnapshot[] = [];

  constructor(options?: ContextTrackerOptions) {
    this.modelContextWindow = options?.modelContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.maxHistorySize = options?.maxHistorySize ?? DEFAULT_MAX_HISTORY;
    this.bytesPerToken = options?.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
  }

  recordToolCall(record: ToolCallRecord): void {
    const bytes = record.outputSizeBytes;
    if (bytes == null || bytes <= 0) return;
    const current = this.toolOutputBytes.get(record.toolName) ?? 0;
    this.toolOutputBytes.set(record.toolName, current + bytes);
  }

  recordTurn(event: TokenEvent): ContextTurnSnapshot {
    this.turnCount++;
    const now = event.timestamp;

    // Refine the context window from the model on this event. Anthropic
    // returns the model in usage metadata (e.g. claude-opus-4-7 → 1M window).
    // Without this lookup, a 250K-token Opus 4.7 conversation would render
    // as 125% fill against the 200K default.
    //
    // Take the max — never shrink. The cap can grow during a session
    // (default 200K → resolved 1M on first Opus turn) but must not shrink
    // when a smaller-window model (e.g. Haiku sub-agent at 200K) follows
    // a larger one (Opus at 1M). Cached history is still indexed against
    // the larger context, so a 605K-token snapshot would otherwise read as
    // 302% fillPercent against a shrunken 200K cap.
    if (event.model) {
      const pricing = resolveModelPricing(event.model);
      if (pricing && pricing.contextWindow > this.modelContextWindow) {
        this.modelContextWindow = pricing.contextWindow;
      }
    }

    // Total context = new tokens + cached tokens (Anthropic reports input_tokens
    // as only the uncached portion; cache_read + cache_creation are the rest)
    const totalContext = event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens;

    if (this.turnCount === 1) {
      this.firstTurnInputTokens = totalContext;
      // Heuristic: on a cold session cacheCreationTokens holds the newly-cached
      // system prompt and is a reasonable system baseline. On warm-cache sessions
      // (resumed conversation) cacheCreationTokens is 0 because the prompt is
      // already cached, so the system baseline is unknown and we leave it at 0.
      // Using cacheReadTokens as a fallback would overshoot: it contains the
      // full prior context (system + all history), not just the system prompt.
      this.systemBaseline = event.cacheCreationTokens;
    }

    this.currentInputTokens = totalContext;
    const fillPercent =
      this.modelContextWindow > 0 ? (totalContext / this.modelContextWindow) * 100 : 0;

    const breakdown = this.estimateBreakdown(totalContext);

    const snapshot: ContextTurnSnapshot = {
      turnNumber: this.turnCount,
      timestamp: now,
      inputTokens: totalContext,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      fillPercent: Math.round(fillPercent * 100) / 100,
      breakdown,
    };

    this.history.push(snapshot);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Output tokens from this turn become part of next turn's context
    this.cumulativeAssistantTokens += event.outputTokens;

    return snapshot;
  }

  getGrowth(): ContextGrowthSummary {
    return {
      startTokens: this.firstTurnInputTokens,
      currentTokens: this.currentInputTokens,
      deltaTokens: this.currentInputTokens - this.firstTurnInputTokens,
    };
  }

  getToolContributions(): ToolContextContribution[] {
    const totalBytes = [...this.toolOutputBytes.values()].reduce((sum, b) => sum + b, 0);
    if (totalBytes === 0) return [];

    return [...this.toolOutputBytes.entries()]
      .map(([tool, bytes]) => ({
        tool,
        totalBytes: bytes,
        estimatedTokens: Math.round(bytes / this.bytesPerToken),
        percentOfToolOutput: Math.round((bytes / totalBytes) * 10000) / 100,
      }))
      .sort((a, b) => b.totalBytes - a.totalBytes);
  }

  getMetrics(): ContextTrackerMetrics {
    const fillPercent =
      this.modelContextWindow > 0 ? (this.currentInputTokens / this.modelContextWindow) * 100 : 0;

    return {
      turnCount: this.turnCount,
      growth: this.getGrowth(),
      currentBreakdown: this.getCurrentBreakdown(),
      fillPercent: Math.round(fillPercent * 100) / 100,
      contextWindow: this.modelContextWindow,
      toolContributions: this.getToolContributions(),
      history: this.history,
    };
  }

  reset(_sessionId: string): void {
    this.turnCount = 0;
    this.firstTurnInputTokens = 0;
    this.currentInputTokens = 0;
    this.systemBaseline = 0;
    this.cumulativeAssistantTokens = 0;
    this.toolOutputBytes.clear();
    this.history.length = 0;
  }

  private getCurrentBreakdown(): ContextBreakdown {
    if (this.turnCount === 0) {
      return { system: 0, tools: 0, user: 0, assistant: 0 };
    }
    return this.history[this.history.length - 1].breakdown;
  }

  private estimateBreakdown(totalContext: number): ContextBreakdown {
    const total = totalContext;
    if (total === 0) return { system: 0, tools: 0, user: 0, assistant: 0 };

    const system = Math.min(this.systemBaseline, total);

    const totalToolBytes = [...this.toolOutputBytes.values()].reduce((sum, b) => sum + b, 0);
    const toolEstimate = Math.round(totalToolBytes / this.bytesPerToken);
    const tools = Math.min(toolEstimate, total - system);

    const assistant = Math.min(this.cumulativeAssistantTokens, total - system - tools);

    const user = Math.max(0, total - system - tools - assistant);

    return { system, tools, user, assistant };
  }
}

// ---------------------------------------------------------------------------
// Per-session registry
// ---------------------------------------------------------------------------

export class ContextTrackerRegistry {
  private readonly trackers = new Map<string, ContextTracker>();
  private readonly options: ContextTrackerOptions | undefined;
  private readonly maxSessions: number;

  constructor(options?: ContextTrackerOptions & { maxSessions?: number }) {
    this.options = options;
    this.maxSessions = options?.maxSessions ?? 50;
  }

  private getOrCreate(sessionId: string): ContextTracker {
    let tracker = this.trackers.get(sessionId);
    if (tracker) {
      // Move to end for LRU ordering
      this.trackers.delete(sessionId);
      this.trackers.set(sessionId, tracker);
      return tracker;
    }
    if (this.trackers.size >= this.maxSessions) {
      const oldest = this.trackers.keys().next().value;
      if (oldest !== undefined) this.trackers.delete(oldest);
    }
    tracker = new ContextTracker(this.options);
    this.trackers.set(sessionId, tracker);
    return tracker;
  }

  recordToolCall(record: ToolCallRecord): void {
    const sessionId = record.sessionId;
    if (!sessionId) return;
    this.getOrCreate(sessionId).recordToolCall(record);
  }

  recordTurn(event: TokenEvent): ContextTurnSnapshot | null {
    const sessionId = event.sessionId;
    if (!sessionId) return null;
    return this.getOrCreate(sessionId).recordTurn(event);
  }

  getMetrics(sessionId?: string): ContextTrackerMetrics {
    const empty: ContextTrackerMetrics = {
      turnCount: 0,
      growth: { startTokens: 0, currentTokens: 0, deltaTokens: 0 },
      currentBreakdown: { system: 0, tools: 0, user: 0, assistant: 0 },
      fillPercent: 0,
      contextWindow: this.options?.modelContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      toolContributions: [],
      history: [],
    };

    if (sessionId) {
      const tracker = this.trackers.get(sessionId);
      return tracker ? tracker.getMetrics() : empty;
    }
    // No sessionId specified — return most recently active tracker
    const entries = [...this.trackers.entries()];
    if (entries.length === 0) return empty;
    return entries[entries.length - 1]![1].getMetrics();
  }

  getTracker(sessionId: string): ContextTracker | undefined {
    return this.trackers.get(sessionId);
  }

  getSessionIds(): string[] {
    return [...this.trackers.keys()];
  }
}
