import type { JSX } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatAxisUsd, formatUsd } from '../lib/format';

export interface SpendBarsDatum {
  readonly key: string;
  readonly label: string;
  readonly spendUsd: number;
  readonly cumulativeUsd: number | null;
  readonly projectedUsd: number | null;
}

export interface SpendBarsProps {
  readonly data: ReadonlyArray<SpendBarsDatum>;
  readonly height?: number;
  readonly xTickFormatter?: (key: string) => string;
  readonly yTickFormatter?: (value: number) => string;
  readonly tooltipLabel?: (datum: SpendBarsDatum) => string;
}

const DEFAULT_HEIGHT = 176;
const TICK_STYLE = { fill: 'var(--color-ink-muted)', fontSize: 10 };
const GRID_STROKE = 'var(--color-border-subtle)';
const TOOLTIP_STYLE = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-medium)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-ink-base)',
};
const BAR_FILL = 'var(--color-chart-block)';
const LINE_STROKE = 'var(--color-accent-green)';

interface SpendBarsTooltipProps {
  readonly active?: boolean;
  readonly payload?: ReadonlyArray<{ readonly payload: SpendBarsDatum }>;
  readonly tooltipLabel?: (datum: SpendBarsDatum) => string;
}

function SpendBarsTooltip({
  active,
  payload,
  tooltipLabel,
}: SpendBarsTooltipProps): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]!.payload;
  const header = tooltipLabel ? tooltipLabel(datum) : datum.label;
  const lines = [`${header} — ${formatUsd(datum.spendUsd)}`];
  if (datum.cumulativeUsd != null) {
    lines.push(`${header} — cumulative ${formatUsd(datum.cumulativeUsd)}`);
  }
  if (datum.projectedUsd != null) {
    lines.push(`${header} — projected ${formatUsd(datum.projectedUsd)}`);
  }
  return (
    <div style={TOOLTIP_STYLE} className="px-2 py-1.5">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

export function SpendBars({
  data,
  height = DEFAULT_HEIGHT,
  xTickFormatter,
  yTickFormatter = formatAxisUsd,
  tooltipLabel,
}: SpendBarsProps): JSX.Element {
  const hasCumulative = data.some((d) => d.cumulativeUsd != null);
  const hasProjected = data.some((d) => d.projectedUsd != null);

  return (
    <div className="min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <ComposedChart data={data as SpendBarsDatum[]}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey="key"
            tick={TICK_STYLE}
            stroke={GRID_STROKE}
            tickFormatter={xTickFormatter}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} tickFormatter={yTickFormatter} />
          <Tooltip
            content={(props: unknown) => (
              <SpendBarsTooltip
                {...(props as unknown as SpendBarsTooltipProps)}
                tooltipLabel={tooltipLabel}
              />
            )}
            cursor={false}
          />
          <Bar dataKey="spendUsd" fill={BAR_FILL} radius={[3, 3, 0, 0]} />
          {hasCumulative && (
            <Line
              type="monotone"
              dataKey="cumulativeUsd"
              stroke={LINE_STROKE}
              strokeWidth={2}
              dot={false}
            />
          )}
          {hasProjected && (
            <Line
              type="monotone"
              dataKey="projectedUsd"
              stroke={LINE_STROKE}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
