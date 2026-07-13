import { useState } from 'react';

export interface HourlyCostEntry {
  readonly hour: number; // 0..23
  readonly cost: number;
}

export interface HourlyCostBlocksProps {
  readonly hours: ReadonlyArray<HourlyCostEntry>;
  readonly formatValue?: (v: number) => string;
  readonly ariaLabel?: string;
}

const BLOCK_PX = 6;
const BLOCK_GAP_PX = 1;
const TARGET_PEAK_BLOCKS = 5;

// Friendly per-block cost values; we pick the smallest one that yields no more
// than TARGET_PEAK_BLOCKS rows for the peak hour. Keeps stack heights legible
// regardless of whether today is a $0.40 day or a $40 day.
const NICE_UNITS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

function pickBlockUnit(raw: number): number {
  if (raw <= 0) return 0.01;
  for (const c of NICE_UNITS) if (c >= raw) return c;
  return NICE_UNITS[NICE_UNITS.length - 1]!;
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12am';
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return '12pm';
  return `${hour - 12}pm`;
}

function describeChart(hours: ReadonlyArray<HourlyCostEntry>): string {
  const total = hours.reduce((s, h) => s + h.cost, 0);
  const max = hours.reduce((m, h) => Math.max(m, h.cost), 0);
  const peak = hours.find((h) => h.cost === max)!;
  return `Hourly spend today: $${total.toFixed(2)} total, peak $${max.toFixed(2)} at ${formatHourLabel(peak.hour)}`;
}

export function HourlyCostBlocks({
  hours,
  formatValue,
  ariaLabel,
}: HourlyCostBlocksProps): JSX.Element | null {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const maxCost = hours.reduce((m, h) => Math.max(m, h.cost), 0);
  if (maxCost === 0) return null;

  const blockUnit = pickBlockUnit(maxCost / TARGET_PEAK_BLOCKS);
  const blocksPerCol = hours.map((h) => Math.max(0, Math.round(h.cost / blockUnit)));
  const maxBlocks = blocksPerCol.reduce((m, n) => Math.max(m, n), 0);
  // When maxCost > 0 but all costs are below the smallest renderable unit
  // (e.g. $0.001 total), every column rounds to 0 blocks. Return null instead
  // of rendering an invisible 7px container.
  if (maxBlocks === 0) return null;

  const chartHeight = maxBlocks * (BLOCK_PX + BLOCK_GAP_PX);
  const fmt = formatValue ?? ((v: number) => `$${v.toFixed(2)}`);
  const label = ariaLabel ?? describeChart(hours);

  const hovered = hoverIdx !== null ? hours[hoverIdx] : null;
  const tooltipText = hovered
    ? `${formatHourLabel(hovered.hour)}: ${fmt(hovered.cost)} (start hour)`
    : '';
  // Tooltip anchors to the centre of the (hoverIdx)-th column. With every
  // column rendered via flex-1, the centre of column N in a layout of K
  // columns is at ((N + 0.5) / K) * 100 % of the chart width.
  const tooltipLeftPct = hoverIdx !== null ? ((hoverIdx + 0.5) / hours.length) * 100 : 0;

  return (
    <div className="relative">
      <div
        role="img"
        aria-label={label}
        className="flex w-full"
        style={{ height: chartHeight }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {hours.map((h, colIdx) => {
          const blocks = blocksPerCol[colIdx]!;
          const isPeak = h.cost > 0 && h.cost === maxCost;
          const cells: JSX.Element[] = [];
          for (let b = 0; b < blocks; b++) {
            cells.push(
              <span
                key={b}
                className="absolute rounded-sm heatmap-cell"
                style={{
                  // Stack from the bottom up; index 0 is the lowest block.
                  bottom: b * (BLOCK_PX + BLOCK_GAP_PX),
                  // Centre via left + negative margin (not transform, because
                  // the .heatmap-cell enter animation owns transform: scale()).
                  left: '50%',
                  marginLeft: -BLOCK_PX / 2,
                  width: BLOCK_PX,
                  height: BLOCK_PX,
                  backgroundColor: isPeak
                    ? 'var(--color-chart-block-peak)'
                    : 'var(--color-chart-block)',
                  animationDelay: `${colIdx * 12 + b * 6}ms`,
                }}
              />,
            );
          }
          return (
            <div
              key={colIdx}
              className="relative flex-1 h-full"
              onMouseEnter={() => setHoverIdx(colIdx)}
            >
              {cells}
            </div>
          );
        })}
      </div>
      {hovered && (
        <div
          className="absolute -top-7 px-1.5 py-0.5 bg-bg-elevated border border-border-subtle text-[10px] text-ink-base rounded-md shadow-md pointer-events-none whitespace-nowrap tabular-nums"
          style={{
            left: `${tooltipLeftPct}%`,
            // Centre the tooltip on the column it describes; the small
            // overflow at hours 0/23 is acceptable for a glance chart.
            transform: 'translateX(-50%)',
          }}
          role="tooltip"
        >
          {tooltipText}
        </div>
      )}
    </div>
  );
}
