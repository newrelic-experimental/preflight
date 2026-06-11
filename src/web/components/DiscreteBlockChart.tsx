import { useRef, useState } from 'react';

/**
 * Shared discrete-block chart used by the Today view's `ConcurrencyIndicator`
 * and the History view's per-day peak chart. Each item renders as a column of
 * stacked square blocks bottom-aligned within a fixed-height SVG. The SVG
 * scales horizontally to the container via `width="100%"` + `viewBox` +
 * `xMidYMax meet`. Tooltip placement uses `getBoundingClientRect` against the
 * actually-rendered column group rather than a viewBox-derived percentage, so
 * it survives BOTH the horizontal scale (Today's 96-bucket case where the
 * chart fills width) AND the centering offset (History's narrow-data case
 * where the chart is height-limited and centered with empty side margins).
 */

export interface DiscreteBlockChartItem {
  readonly count: number;
  /**
   * Pre-formatted tooltip string. The chart does no formatting itself —
   * callers tailor the label (e.g. `"14:30 — 2 concurrent"` for the day
   * grid, `"06-09: 3"` for the daily-peak grid).
   */
  readonly tooltip: string;
}

export interface DiscreteBlockChartProps {
  readonly data: readonly DiscreteBlockChartItem[];
  /**
   * Optional override for the y-axis maximum used to scale chart height
   * and to color the peak cells. Defaults to `max(data[].count)` with a
   * floor of 1.
   */
  readonly maxCount?: number;
  readonly ariaLabel: string;
}

const BLOCK_COLOR = 'rgba(0, 212, 170, 0.7)';
const BLOCK_COLOR_PEAK = 'rgba(0, 212, 170, 1)';

const BLOCK_SIZE = 10;
const BLOCK_GAP = 2;
const COL_GAP = 3;
const COL_WIDTH = BLOCK_SIZE + COL_GAP;

export function DiscreteBlockChart({
  data,
  maxCount,
  ariaLabel,
}: DiscreteBlockChartProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // Empty-state: render nothing so callers can show their own empty UI in
  // the surrounding layout rather than reserving height for a blank chart.
  if (data.length === 0 || data.every((d) => d.count === 0)) {
    return null;
  }

  const effectiveMax = Math.max(maxCount ?? 0, ...data.map((d) => d.count), 1);
  const chartHeight = effectiveMax * (BLOCK_SIZE + BLOCK_GAP);
  const chartWidth = data.length * COL_WIDTH;

  return (
    <div ref={containerRef} className="relative">
      <svg
        width="100%"
        height={chartHeight}
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="xMidYMax meet"
        onMouseLeave={() => setTooltip(null)}
      >
        {data.map((item, colIdx) => {
          const blocks: JSX.Element[] = [];
          for (let b = 0; b < item.count; b++) {
            const isPeak = item.count === effectiveMax;
            blocks.push(
              <rect
                key={`${colIdx}-${b}`}
                x={colIdx * COL_WIDTH}
                y={chartHeight - (b + 1) * (BLOCK_SIZE + BLOCK_GAP)}
                width={BLOCK_SIZE}
                height={BLOCK_SIZE}
                rx={1}
                fill={isPeak ? BLOCK_COLOR_PEAK : BLOCK_COLOR}
                className="heatmap-cell"
                style={{ animationDelay: `${colIdx * 20 + b * 10}ms` }}
              />,
            );
          }
          return (
            <g
              key={colIdx}
              onMouseEnter={(e) => {
                const parent = containerRef.current;
                if (!parent) return;
                const parentRect = parent.getBoundingClientRect();
                // Anchor the tooltip to the topmost visible block when the
                // column has any (`heatmap-cell` rects, ordered bottom-to-top
                // in render order — last is highest); fall back to the
                // group's bounds for empty (count=0) columns. This keeps the
                // tooltip glued to the data point regardless of how tall the
                // chart is.
                const target = e.currentTarget as SVGGElement;
                const blocks = target.querySelectorAll<SVGRectElement>('rect.heatmap-cell');
                const anchor = blocks[blocks.length - 1] ?? target;
                const bounds = anchor.getBoundingClientRect();
                setTooltip({
                  x: bounds.left - parentRect.left + bounds.width / 2,
                  y: bounds.top - parentRect.top,
                  text: item.tooltip,
                });
              }}
            >
              <rect
                x={colIdx * COL_WIDTH}
                y={0}
                width={COL_WIDTH}
                height={chartHeight}
                fill="transparent"
              />
              {blocks}
            </g>
          );
        })}
      </svg>
      {tooltip && (
        <div
          className="absolute px-1.5 py-0.5 bg-bg-elevated text-[10px] text-ink-default rounded shadow-md pointer-events-none whitespace-nowrap"
          // Tooltip bottom-edge sits 4 px above the column's topmost block.
          // Computed in container-relative pixels via getBoundingClientRect,
          // so it survives the SVG's scale + centering under
          // `xMidYMax meet`.
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, calc(-100% - 4px))',
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
