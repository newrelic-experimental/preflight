import { useRef, useEffect, useState, useId } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';

import {
  fetchContext,
  fetchContextComposition,
  fetchContextEfficiency,
  qk,
  type ContextResponse,
  type ContextCompositionResponse,
  type ContextEfficiencyResponse,
} from '../api/client';
import { useLiveStore, type ContextUpdateEvent } from '../store/liveStore';
import { Eyebrow, Pill } from './ui';

export interface ContextBarProps {
  readonly data?: ContextResponse | null;
  readonly sessionId?: string | null;
  readonly expandable?: boolean;
}

const CATEGORIES = ['system', 'tools', 'user', 'assistant'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  system: 'bg-accent-indigo',
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
  system: 'bg-accent-indigo',
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

const CHART_COLORS: Record<string, string> = {
  system: '#6366f1',
  tools: '#ffb224',
  user: '#0095ff',
  assistant: '#1ce783',
};

const CHART_TICK_STYLE = { fontSize: 10, fill: '#6b7280' } as const;
const CHART_GRID_STROKE = '#2a2a3a';

export interface ContextTimelineProps {
  readonly history: ContextResponse['history'];
  readonly contextWindow: number;
}

export function ContextTimeline({
  history,
  contextWindow,
}: ContextTimelineProps): JSX.Element | null {
  const gradientId = useId();
  if (history.length < 2) return null;

  const chartData = history.map((snap) => ({
    turn: snap.turnNumber,
    system: contextWindow > 0 ? (snap.breakdown.system / contextWindow) * 100 : 0,
    tools: contextWindow > 0 ? (snap.breakdown.tools / contextWindow) * 100 : 0,
    user: contextWindow > 0 ? (snap.breakdown.user / contextWindow) * 100 : 0,
    assistant: contextWindow > 0 ? (snap.breakdown.assistant / contextWindow) * 100 : 0,
  }));

  return (
    <div className="mt-2 pt-2 border-t border-surface-3">
      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.25} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
          <XAxis dataKey="turn" tick={CHART_TICK_STYLE} stroke={CHART_GRID_STROKE} />
          <YAxis domain={[0, 100]} unit="%" tick={CHART_TICK_STYLE} stroke={CHART_GRID_STROKE} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a2e',
              border: '1px solid #2a2a3a',
              fontSize: 11,
            }}
            formatter={(value: unknown, name: unknown) => [
              `${(value as number).toFixed(1)}%`,
              name as string,
            ]}
            labelFormatter={(label: unknown) => `Turn ${label as number}`}
          />
          <ReferenceArea y1={80} y2={100} fill={`url(#${gradientId})`} ifOverflow="visible" />
          {CATEGORIES.map((cat) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stackId="context"
              stroke={CHART_COLORS[cat]}
              fill={CHART_COLORS[cat]}
              fillOpacity={0.4}
              strokeWidth={1}
              dot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function toContextEvent(api: ContextResponse, sessionId = ''): ContextUpdateEvent {
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

export function ContextBar({
  data,
  sessionId,
  expandable = true,
}: ContextBarProps): JSX.Element | null {
  const contextBySession = useLiveStore((s) => s.contextBySession);
  const liveContext = sessionId ? (contextBySession.get(sessionId) ?? null) : null;
  const [hoveredCat, setHoveredCat] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const prevFillRef = useRef(0);
  const prevTokensRef = useRef(0);

  useEffect(() => {
    setShowTimeline(false);
  }, [sessionId]);

  const { data: apiContext } = useQuery<ContextResponse>({
    queryKey: sessionId ? ['context', sessionId] : qk.context,
    queryFn: () => fetchContext(sessionId ?? undefined),
    refetchInterval: 10_000,
    enabled: !data,
  });

  const { data: composition } = useQuery<ContextCompositionResponse>({
    queryKey: ['context-composition', sessionId],
    queryFn: fetchContextComposition,
    enabled: showTimeline,
  });
  const { data: efficiency } = useQuery<ContextEfficiencyResponse>({
    queryKey: ['context-efficiency', sessionId],
    queryFn: fetchContextEfficiency,
    enabled: showTimeline,
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

  const timelineHistory =
    showTimeline && source?.history && source.history.length >= 2 ? source.history : null;

  return (
    <div className="group">
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Eyebrow>Context</Eyebrow>
          {atCapacity && (
            <Pill
              tone="danger"
              size="sm"
              uppercase
              className="animate-pulse motion-reduce:animate-none"
            >
              at capacity
            </Pill>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-ink-subtle tabular-nums">
          {formatTokens(growth.currentTokens)}
          {contextWindow && contextWindow > 0 && (
            <span className="text-ink-muted">{` / ${formatTokens(contextWindow)}`}</span>
          )}
          {growth.delta > 0 && (
            <span className="text-accent-amber ml-1">+{formatTokens(growth.delta)}</span>
          )}
          {growth.delta < 0 && <span className="text-accent-cyan ml-1">compacted</span>}
          {expandable && (source?.history?.length ?? 0) >= 2 && (
            <button
              onClick={() => setShowTimeline((v) => !v)}
              className="ml-1 text-ink-muted hover:text-ink-base transition-colors"
              aria-label="Toggle context timeline"
              aria-expanded={showTimeline}
            >
              {showTimeline ? '▾' : '▸'}
            </button>
          )}
        </div>
      </div>

      {/* Stacked bar */}
      <div className="relative">
        {compacting && (
          <div className="absolute inset-0 rounded-full bg-accent-cyan/20 animate-compact-flash pointer-events-none" />
        )}
        <div
          className={`w-full h-3 bg-surface-3 rounded-full overflow-hidden flex transition-colors duration-150 ${grew ? 'shadow-[0_0_12px_rgba(255,178,36,0.3)]' : ''} ${compacting ? 'animate-compact' : ''}`}
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

      {expandable && (
        <div
          className={`overflow-hidden transition-all duration-300 ${showTimeline ? 'max-h-56' : 'max-h-0'}`}
        >
          {timelineHistory && (
            <ContextTimeline history={timelineHistory} contextWindow={contextWindow} />
          )}
          {showTimeline && efficiency && efficiency.repeatedReadRatio !== null && (
            <div className="mt-2 text-xs text-ink-muted">
              <span>Repeated reads: {Math.round(efficiency.repeatedReadRatio * 100)}%</span>
              {efficiency.topRepeatedFiles[0] && (
                <span className="ml-2">
                  top:{' '}
                  <code className="bg-surface-5 px-1 rounded">
                    {efficiency.topRepeatedFiles[0].file}
                  </code>{' '}
                  ({efficiency.topRepeatedFiles[0].readCount}x)
                </span>
              )}
            </div>
          )}
          {showTimeline && composition && (
            <div className="mt-1 text-xs text-ink-muted">
              Dominant this turn:{' '}
              {Object.entries(composition.currentBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
