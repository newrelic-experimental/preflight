import { useRef, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchContext, qk } from '../api/client';
import { useLiveStore, type ContextUpdateEvent } from '../store/liveStore';

export interface ContextApiResponse {
  readonly turnCount: number;
  readonly growth: {
    readonly startTokens: number;
    readonly currentTokens: number;
    readonly deltaTokens: number;
  };
  readonly currentBreakdown: {
    readonly system: number;
    readonly tools: number;
    readonly user: number;
    readonly assistant: number;
  };
  readonly fillPercent: number;
  /**
   * Per-model context window cap (tokens). Resolved from the model in the
   * Anthropic usage metadata — claude-opus-4-7 → 1_000_000, claude-haiku-4-5 →
   * 200_000, etc. UI formats this as "X / Y" so a 250K Opus session reads as
   * "250K / 1M (25%)" instead of "250K (125%)".
   */
  readonly contextWindow: number;
  readonly toolContributions: ReadonlyArray<{
    readonly tool: string;
    readonly totalBytes: number;
    readonly estimatedTokens: number;
    readonly percentOfToolOutput: number;
  }>;
}

export interface ContextBarProps {
  readonly data?: ContextApiResponse | null;
  readonly sessionId?: string | null;
}

const CATEGORIES = ['system', 'tools', 'user', 'assistant'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  system: 'bg-[#6366f1]',
  tools: 'bg-accent-amber',
  user: 'bg-accent-blue',
  assistant: 'bg-accent-green',
};

const CATEGORY_GLOW: Record<string, string> = {
  system: 'shadow-[0_0_8px_rgba(99,102,241,0.4)]',
  tools: 'shadow-[0_0_8px_rgba(255,178,36,0.4)]',
  user: 'shadow-[0_0_8px_rgba(0,149,255,0.4)]',
  assistant: 'shadow-[0_0_8px_rgba(28,231,131,0.4)]',
};

const CATEGORY_DOT_COLORS: Record<string, string> = {
  system: 'bg-[#6366f1]',
  tools: 'bg-accent-amber',
  user: 'bg-accent-blue',
  assistant: 'bg-accent-green',
};

const CATEGORY_LABELS: Record<string, string> = {
  system: 'System',
  tools: 'Tools',
  user: 'User',
  assistant: 'Assistant',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function toContextEvent(api: ContextApiResponse, sessionId = ''): ContextUpdateEvent {
  return {
    sessionId,
    turnNumber: api.turnCount,
    totalTokens: api.growth.currentTokens,
    fillPercent: api.fillPercent,
    contextWindow: api.contextWindow,
    breakdown: api.currentBreakdown,
    growth: {
      startTokens: api.growth.startTokens,
      currentTokens: api.growth.currentTokens,
      delta: api.growth.deltaTokens,
    },
    topTools: api.toolContributions.map((tc) => ({
      tool: tc.tool,
      estimatedTokens: tc.estimatedTokens,
    })),
  };
}

export function ContextBar({ data, sessionId }: ContextBarProps): JSX.Element | null {
  const contextBySession = useLiveStore((s) => s.contextBySession);
  const liveContext = sessionId ? (contextBySession.get(sessionId) ?? null) : null;
  const [hoveredCat, setHoveredCat] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const prevFillRef = useRef(0);
  const prevTokensRef = useRef(0);

  const { data: apiContext } = useQuery<ContextApiResponse>({
    queryKey: sessionId ? ['context', sessionId] : qk.context,
    queryFn: () => fetchContext(sessionId ?? undefined) as Promise<ContextApiResponse>,
    refetchInterval: 10_000,
    enabled: !data,
  });

  const source = data ?? apiContext;
  const sid = sessionId ?? '';
  const ctx: ContextUpdateEvent | null = data
    ? toContextEvent(data, sid)
    : (liveContext ?? (source ? toContextEvent(source, sid) : null));

  const currentTokens = ctx?.growth.currentTokens ?? 0;
  const cappedFill = Math.min(ctx?.fillPercent ?? 0, 100);
  const hasRendered = prevTokensRef.current > 0;
  const grew = hasRendered && cappedFill > prevFillRef.current;

  useEffect(() => {
    // Detect compaction: tokens dropped significantly from previous reading
    if (prevTokensRef.current > 0 && currentTokens < prevTokensRef.current * 0.7) {
      setCompacting(true);
      const timer = setTimeout(() => setCompacting(false), 1000);
      prevTokensRef.current = currentTokens;
      prevFillRef.current = cappedFill;
      return () => clearTimeout(timer);
    }
    prevTokensRef.current = currentTokens;
    prevFillRef.current = cappedFill;
  }, [cappedFill, currentTokens]);

  if (!ctx || ctx.totalTokens === 0) return null;

  const { breakdown, growth, fillPercent, totalTokens } = ctx;
  const atCapacity = fillPercent >= 100;
  // contextWindow now lives on ctx (mirrored on both SSE liveContext and the
  // API snapshot). Reading from ctx.contextWindow keeps the numerator and
  // denominator coming from the same source — without this, a freshly-
  // resolved 1M Opus cap on the SSE event could render against a stale
  // 200K default still cached on the 10s-polling apiContext, producing a
  // bar like "250K / 200K" with a 25% legend.
  const contextWindow = ctx.contextWindow;

  return (
    <div className="group">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <div className="text-[10px] text-ink-muted uppercase tracking-wider">Context</div>
          {atCapacity && (
            <span className="text-[9px] bg-accent-red/15 text-accent-red px-1.5 py-0.5 rounded-full font-medium animate-pulse motion-reduce:animate-none">
              at capacity
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-subtle tabular-nums">
          {formatTokens(growth.currentTokens)}
          {contextWindow && contextWindow > 0 && (
            <span className="text-ink-muted">{` / ${formatTokens(contextWindow)}`}</span>
          )}
          {growth.delta > 0 && (
            <span className="text-accent-amber ml-1">+{formatTokens(growth.delta)}</span>
          )}
          {growth.delta < 0 && <span className="text-accent-cyan ml-1">compacted</span>}
        </div>
      </div>

      {/* Stacked bar */}
      <div className="relative">
        {compacting && (
          <div className="absolute inset-0 rounded-full bg-accent-cyan/20 animate-compact-flash pointer-events-none" />
        )}
        <div
          className={`w-full h-3 bg-surface-3 rounded-full overflow-hidden flex transition-shadow duration-500 ${grew ? 'shadow-[0_0_12px_rgba(255,178,36,0.3)]' : ''} ${compacting ? 'animate-compact' : ''}`}
        >
          {CATEGORIES.map((cat) => {
            const tokens = breakdown[cat];
            if (tokens <= 0) return null;
            const pct = Math.round((tokens / totalTokens) * 100);
            const isHovered = hoveredCat === cat;
            return (
              <div
                key={cat}
                className={`${CATEGORY_COLORS[cat]} transition-all duration-500 ease-out cursor-default relative ${isHovered ? `brightness-125 ${CATEGORY_GLOW[cat]}` : ''}`}
                style={{ width: `${(tokens / totalTokens) * cappedFill}%` }}
                title={`${CATEGORY_LABELS[cat]}: ${formatTokens(tokens)} (${pct}%)`}
                onMouseEnter={() => setHoveredCat(cat)}
                onMouseLeave={() => setHoveredCat(null)}
              />
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-muted">
        {CATEGORIES.map((cat) => {
          const tokens = breakdown[cat];
          const isHovered = hoveredCat === cat;
          return (
            <span
              key={cat}
              className={`flex items-center gap-1 transition-colors duration-200 cursor-default ${isHovered ? 'text-ink-base' : ''}`}
              onMouseEnter={() => setHoveredCat(cat)}
              onMouseLeave={() => setHoveredCat(null)}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${CATEGORY_DOT_COLORS[cat]} ${isHovered ? 'scale-150' : ''} transition-transform duration-200`}
              />
              {CATEGORY_LABELS[cat]}
              {isHovered && tokens > 0 && (
                <span className="text-ink-subtle ml-0.5">{formatTokens(tokens)}</span>
              )}
            </span>
          );
        })}
        <span
          className={`ml-auto tabular-nums ${atCapacity ? 'text-accent-red' : cappedFill >= 75 ? 'text-accent-amber' : ''}`}
        >
          {cappedFill.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
