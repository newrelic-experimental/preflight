import { useMemo, useState } from 'react';

export interface ActivityHeatmapProps {
  readonly variant: 'strip' | 'grid';
  readonly buckets: number[];
  readonly maxCount: number;
  readonly labels?: string[];
  readonly bucketSizeMs?: number;
  readonly startTimestamp?: number;
  readonly width?: number;
  readonly height?: number;
  readonly ariaLabel?: string;
  /** For grid variant: array of {date, count} */
  readonly days?: ReadonlyArray<{ date: string; count: number }>;
}

const INTENSITY_LEVELS = 5;
const COLORS = [
  'var(--color-heatmap-0)',
  'var(--color-heatmap-1)',
  'var(--color-heatmap-2)',
  'var(--color-heatmap-3)',
  'var(--color-heatmap-4)',
];

function intensityColor(count: number, maxCount: number): string {
  if (count === 0) return COLORS[0]!;
  const ratio = count / maxCount;
  const level = Math.min(Math.ceil(ratio * (INTENSITY_LEVELS - 1)), INTENSITY_LEVELS - 1);
  return COLORS[level]!;
}

function formatBucketTime(startTimestamp: number, bucketSizeMs: number, index: number): string {
  const ts = startTimestamp + index * bucketSizeMs;
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ActivityHeatmap({
  variant,
  buckets,
  maxCount,
  bucketSizeMs,
  startTimestamp,
  width,
  height,
  ariaLabel,
  days,
}: ActivityHeatmapProps): JSX.Element {
  if (variant === 'grid' && days) {
    return (
      <GridHeatmap
        days={days}
        maxCount={maxCount}
        width={width}
        height={height}
        ariaLabel={ariaLabel}
      />
    );
  }

  return (
    <StripHeatmap
      buckets={buckets}
      maxCount={maxCount}
      bucketSizeMs={bucketSizeMs}
      startTimestamp={startTimestamp}
      width={width}
      height={height}
      ariaLabel={ariaLabel}
    />
  );
}

interface StripProps {
  readonly buckets: number[];
  readonly maxCount: number;
  readonly bucketSizeMs?: number;
  readonly startTimestamp?: number;
  readonly width?: number;
  readonly height?: number;
  readonly ariaLabel?: string;
}

function StripHeatmap({
  buckets,
  maxCount,
  bucketSizeMs = 900_000,
  startTimestamp = 0,
  width: explicitWidth,
  height = 24,
  ariaLabel,
}: StripProps): JSX.Element {
  const [tooltip, setTooltip] = useState<{ x: number; text: string } | null>(null);
  const cellGap = 1;
  const cellWidth = Math.max(
    4,
    Math.min(12, explicitWidth ? (explicitWidth - buckets.length * cellGap) / buckets.length : 8),
  );
  const totalWidth = explicitWidth ?? buckets.length * (cellWidth + cellGap);

  return (
    <div className="relative">
      <svg
        width={totalWidth}
        height={height}
        role="img"
        aria-label={ariaLabel ?? `Activity heatmap: ${buckets.length} time buckets`}
        className="w-full"
        style={{ maxWidth: totalWidth }}
        viewBox={`0 0 ${totalWidth} ${height}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setTooltip(null)}
      >
        {buckets.map((count, i) => (
          <rect
            key={i}
            x={i * (cellWidth + cellGap)}
            y={0}
            width={cellWidth}
            height={height}
            rx={2}
            fill={intensityColor(count, maxCount)}
            className="heatmap-cell"
            style={{ animationDelay: `${Math.min(i * 8, 400)}ms` }}
            onMouseEnter={(e) => {
              const time = formatBucketTime(startTimestamp, bucketSizeMs, i);
              setTooltip({
                x: (e.currentTarget as SVGRectElement).x.baseVal.value,
                text: `${time}: ${count} calls`,
              });
            }}
          />
        ))}
      </svg>
      {tooltip && (
        <div
          className="absolute -top-7 px-1.5 py-0.5 bg-bg-elevated border border-border-subtle text-[10px] text-ink-base rounded-md shadow-md pointer-events-none whitespace-nowrap tabular-nums"
          style={{ left: tooltip.x }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

interface GridProps {
  readonly days: ReadonlyArray<{ date: string; count: number }>;
  readonly maxCount: number;
  readonly width?: number;
  readonly height?: number;
  readonly ariaLabel?: string;
}

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

function GridHeatmap({ days, maxCount, ariaLabel }: GridProps): JSX.Element {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const grid = useMemo(() => {
    if (days.length === 0) return { weeks: 0, cells: [] };

    const firstDate = new Date(days[0]!.date);
    const firstDow = (firstDate.getDay() + 6) % 7; // Monday=0
    const cells: Array<{ date: string; count: number; row: number; col: number }> = [];
    for (let i = 0; i < days.length; i++) {
      const globalIdx = i + firstDow;
      const row = globalIdx % 7;
      const col = Math.floor(globalIdx / 7);
      cells.push({ ...days[i]!, row, col });
    }
    const weeks = cells.length > 0 ? cells[cells.length - 1]!.col + 1 : 0;
    return { weeks, cells };
  }, [days]);

  const cellSize = 10;
  const cellGap = 2;
  const labelWidth = 28;
  const headerHeight = 14;
  const svgWidth = labelWidth + grid.weeks * (cellSize + cellGap);
  const svgHeight = headerHeight + 7 * (cellSize + cellGap);

  const monthLabels = useMemo(() => {
    const labels: Array<{ text: string; col: number }> = [];
    let lastMonth = '';
    for (const cell of grid.cells) {
      if (cell.row !== 0) continue;
      const month = new Date(cell.date).toLocaleString(undefined, { month: 'short' });
      if (month !== lastMonth) {
        labels.push({ text: month, col: cell.col });
        lastMonth = month;
      }
    }
    return labels;
  }, [grid.cells]);

  return (
    <div className="relative flex justify-center">
      <svg
        width="100%"
        height={svgHeight}
        role="img"
        aria-label={ariaLabel ?? `Activity grid: ${days.length} days`}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Day-of-week labels */}
        {DAY_LABELS.map((label, i) =>
          label ? (
            <text
              key={i}
              x={0}
              y={headerHeight + i * (cellSize + cellGap) + cellSize - 2}
              className="fill-ink-muted"
              fontSize={10}
            >
              {label}
            </text>
          ) : null,
        )}

        {/* Month labels */}
        {monthLabels.map(({ text, col }) => (
          <text
            key={`${text}-${col}`}
            x={labelWidth + col * (cellSize + cellGap)}
            y={10}
            className="fill-ink-muted"
            fontSize={10}
          >
            {text}
          </text>
        ))}

        {/* Cells */}
        {grid.cells.map((cell, i) => (
          <rect
            key={i}
            x={labelWidth + cell.col * (cellSize + cellGap)}
            y={headerHeight + cell.row * (cellSize + cellGap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={intensityColor(cell.count, maxCount)}
            className="heatmap-cell"
            style={{ animationDelay: `${Math.min(i * 3, 300)}ms` }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget as SVGRectElement;
              setTooltip({
                x: rect.x.baseVal.value,
                y: rect.y.baseVal.value - 16,
                text: `${cell.date}: ${cell.count} calls`,
              });
            }}
          />
        ))}
      </svg>
      {tooltip && (
        <div
          className="absolute px-1.5 py-0.5 bg-bg-elevated border border-border-subtle text-[10px] text-ink-base rounded-md shadow-md pointer-events-none whitespace-nowrap tabular-nums"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
      {/* Color legend */}
      <div className="flex items-center gap-1 mt-1.5 text-[10px] text-ink-muted">
        <span>Less</span>
        {COLORS.map((color, i) => (
          <span
            key={i}
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: color }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
