import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared discrete-block chart used by the Today view's `ConcurrencyIndicator`
 * and `ForecastEodCard`, and the History view's per-day peak chart. Each item
 * renders as a column of stacked square blocks bottom-aligned within a
 * fixed-height SVG. The SVG scales horizontally to the container via
 * `width="100%"` + `viewBox` + `xMidYMax meet`. Tooltip placement uses
 * `getBoundingClientRect` against the actually-rendered column group rather
 * than a viewBox-derived percentage, so it survives BOTH the horizontal scale
 * (Today's 96-bucket case where the chart fills width) AND the centering
 * offset (History's narrow-data case where the chart is height-limited and
 * centered with empty side margins). The tooltip itself is portaled to
 * `document.body` and positioned `fixed` from those same viewport
 * coordinates, so it escapes any `overflow-hidden` ancestor (e.g. the
 * `ConcurrencyIndicator` card clips its celebration-burst animation) instead
 * of being clipped by it.
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

// Sourced from `--color-chart-block` / `--color-chart-block-peak` in
// src/web/index.css so the chart flips correctly in light mode (the raw
// teal RGBA was hardcoded for dark mode and stayed the same shade on white).
const BLOCK_COLOR = 'var(--color-chart-block)';
const BLOCK_COLOR_PEAK = 'var(--color-chart-block-peak)';

const BLOCK_SIZE = 10;
const BLOCK_GAP = 2;
const COL_GAP = 3;
const COL_WIDTH = BLOCK_SIZE + COL_GAP;

export function DiscreteBlockChart({
  data,
  maxCount,
  ariaLabel,
}: DiscreteBlockChartProps): JSX.Element | null {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // The tooltip's position is captured once, on mouseEnter, from the
  // anchor's getBoundingClientRect(). It doesn't track the anchor on
  // scroll, so a scroll while hovering would leave it visually detached
  // from the block it's describing — dismiss it instead of showing a
  // stale position. `capture: true` on scroll catches scrolling of any
  // ancestor scroll container, not just the window itself (inner-element
  // scroll events don't bubble in the normal phase).
  useEffect(() => {
    if (!tooltip) return;
    const dismiss = (): void => setTooltip(null);
    window.addEventListener('scroll', dismiss, { capture: true });
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
    };
  }, [tooltip]);

  // Empty-state: render nothing so callers can show their own empty UI in
  // the surrounding layout rather than reserving height for a blank chart.
  if (data.length === 0 || data.every((d) => d.count === 0)) {
    return null;
  }

  const effectiveMax = Math.max(maxCount ?? 0, ...data.map((d) => d.count), 1);
  const chartHeight = effectiveMax * (BLOCK_SIZE + BLOCK_GAP);
  const chartWidth = data.length * COL_WIDTH;

  return (
    <>
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
                  x: bounds.left + bounds.width / 2,
                  y: bounds.top,
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
      {tooltip &&
        createPortal(
          <div
            className="fixed z-50 px-1.5 py-0.5 bg-bg-elevated border border-border-subtle text-[10px] text-ink-base rounded-md shadow-md pointer-events-none whitespace-nowrap tabular-nums"
            // Tooltip bottom-edge sits 4 px above the column's topmost block,
            // in viewport pixels from getBoundingClientRect, so it survives
            // the SVG's scale + centering under `xMidYMax meet` and paints
            // above every ancestor's overflow/stacking context.
            style={{
              left: tooltip.x,
              top: tooltip.y,
              transform: 'translate(-50%, calc(-100% - 4px))',
            }}
          >
            {tooltip.text}
          </div>,
          document.body,
        )}
    </>
  );
}
