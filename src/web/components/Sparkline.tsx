import { useRef, useEffect, useId, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface SparklineProps {
  readonly values: number[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly ariaLabel?: string;
  readonly animate?: boolean;
  /** Optional formatter for the hover tooltip value. Defaults to compact numeric. */
  readonly formatValue?: (value: number) => string;
}

export function Sparkline({
  values,
  width = 280,
  height = 50,
  stroke = 'var(--color-accent-green)',
  ariaLabel,
  animate,
  formatValue,
}: SparklineProps): JSX.Element | null {
  const hasAnimated = useRef<boolean>(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (animate && !hasAnimated.current) {
      hasAnimated.current = true;
    }
  }, [animate]);

  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  function pointAt(i: number): { x: number; y: number } {
    const x = i * stepX;
    const y = height - ((values[i]! - min) / range) * (height - 4) - 2;
    return { x, y };
  }

  const points = values
    .map((_, i) => `${pointAt(i).x.toFixed(1)},${pointAt(i).y.toFixed(1)}`)
    .join(' ');

  // Area polygon: line points + bottom-right + bottom-left
  const areaPoints = `${points} ${width.toFixed(1)},${height} 0,${height}`;

  const gradientId = `spark-grad-${uid}`;
  const glowId = `spark-glow-${uid}`;

  const a11yProps = ariaLabel
    ? { role: 'img' as const, 'aria-label': describeSparkline(ariaLabel, values) }
    : { 'aria-hidden': true as const };

  const shouldAnimate = animate && !hasAnimated.current;

  const lastIdx = values.length - 1;
  const last = pointAt(lastIdx);
  const hover = hoverIdx !== null ? pointAt(hoverIdx) : null;
  const tooltipLeftPct = hoverIdx !== null ? (hoverIdx / lastIdx) * 100 : 0;
  const fmtFn = formatValue ?? fmt;

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * lastIdx);
    setHoverIdx(idx);
  }

  function handlePointerLeave(): void {
    setHoverIdx(null);
  }

  return (
    <div
      ref={wrapperRef}
      className="relative cursor-crosshair"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full block"
        height={height}
        preserveAspectRatio="none"
        {...a11yProps}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
          <filter id={glowId}>
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <polygon
          fill={`url(#${gradientId})`}
          points={areaPoints}
          className={shouldAnimate ? 'animate-sparkline-fill' : undefined}
        />
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          points={points}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${glowId})`}
          pathLength={shouldAnimate ? 1 : undefined}
          className={shouldAnimate ? 'animate-sparkline-draw' : undefined}
        />
        {/* End-point anchor — always visible so the user sees where "now" is. */}
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          fill={stroke}
          stroke="var(--color-bg-base)"
          strokeWidth={1}
        />
        {/* Hover guideline + emphasized dot at the snapped index. */}
        {hover && (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={0}
              y2={height}
              stroke="var(--color-border-strong)"
              strokeWidth={0.8}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hover.x}
              cy={hover.y}
              r={3.5}
              fill={stroke}
              stroke="var(--color-bg-base)"
              strokeWidth={1.5}
            />
          </>
        )}
      </svg>
      {hoverIdx !== null && (
        <div
          className="absolute -top-6 px-1.5 py-0.5 bg-bg-elevated border border-border-subtle text-[10px] text-ink-base rounded-md shadow-md pointer-events-none whitespace-nowrap tabular-nums -translate-x-1/2"
          style={{ left: `${tooltipLeftPct}%` }}
          role="tooltip"
        >
          {fmtFn(values[hoverIdx]!)}
        </div>
      )}
    </div>
  );
}

function describeSparkline(label: string, values: number[]): string {
  const first = values[0];
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return `${label}: ${values.length} points, start ${fmt(first)}, end ${fmt(last)}, min ${fmt(min)}, max ${fmt(max)}`;
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}
