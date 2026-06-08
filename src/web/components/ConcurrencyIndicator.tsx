import { useState, useEffect, useRef } from 'react';

export interface ConcurrencyData {
  readonly current: number;
  readonly peak: number;
  readonly allTimePeak?: number;
  readonly timeSeries: ReadonlyArray<{ timestamp: number; count: number }>;
}

const BLOCK_COLOR = 'rgba(0, 212, 170, 0.7)';
const BLOCK_COLOR_PEAK = 'rgba(0, 212, 170, 1)';
const STORAGE_KEY = 'nr-observe-peak-concurrent';

export function ConcurrencyIndicator({
  current,
  peak,
  allTimePeak,
  timeSeries,
}: ConcurrencyData): JSX.Element {
  const [tooltip, setTooltip] = useState<{ x: number; text: string } | null>(null);
  const [celebration, setCelebration] = useState(false);
  const prevPeakRef = useRef<number | null>(null);
  const maxCount = Math.max(peak, 1);
  const hasData = timeSeries.length > 0 && timeSeries.some((s) => s.count > 0);

  useEffect(() => {
    const effectivePeak = allTimePeak ?? peak;
    if (effectivePeak <= 0) return;
    const stored = parseInt(localStorage.getItem(STORAGE_KEY) ?? '0', 10);
    if (prevPeakRef.current === null) {
      prevPeakRef.current = stored;
    }
    if (effectivePeak > prevPeakRef.current) {
      localStorage.setItem(STORAGE_KEY, String(effectivePeak));
      prevPeakRef.current = effectivePeak;
      setCelebration(true);
      const timer = setTimeout(() => setCelebration(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [peak, allTimePeak]);

  const blockSize = 6;
  const blockGap = 1;
  const colWidth = blockSize + 2;
  const chartHeight = maxCount * (blockSize + blockGap);
  const chartWidth = timeSeries.length * colWidth;

  return (
    <div
      className={`glass-card p-3 relative overflow-hidden${celebration ? ' new-peak-glow' : ''}`}
    >
      {celebration && <CelebrationBurst />}
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
        concurrent sessions
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-lg font-semibold text-accent-teal tabular-nums">{current}</span>
        <span className="text-xs text-ink-muted tabular-nums">
          today peak {peak}
          {allTimePeak && allTimePeak > peak ? ` · all-time ${allTimePeak}` : ''}
        </span>
        {celebration && (
          <span className="text-[10px] text-accent-green font-semibold animate-bounce">
            NEW RECORD!
          </span>
        )}
      </div>
      {hasData && (
        <div className="mt-2 relative">
          <svg
            width={chartWidth}
            height={chartHeight}
            role="img"
            aria-label={`Concurrency over time, peak ${peak}`}
            className="w-full"
            style={{ maxWidth: chartWidth }}
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            onMouseLeave={() => setTooltip(null)}
          >
            {timeSeries.map((sample, colIdx) => {
              const blocks: JSX.Element[] = [];
              for (let b = 0; b < sample.count; b++) {
                const isPeak = sample.count === peak;
                blocks.push(
                  <rect
                    key={`${colIdx}-${b}`}
                    x={colIdx * colWidth}
                    y={chartHeight - (b + 1) * (blockSize + blockGap)}
                    width={blockSize}
                    height={blockSize}
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
                  onMouseEnter={() => {
                    const d = new Date(sample.timestamp);
                    const time = d.toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    });
                    setTooltip({ x: colIdx * colWidth, text: `${time}: ${sample.count}` });
                  }}
                >
                  <rect
                    x={colIdx * colWidth}
                    y={0}
                    width={colWidth}
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
              className="absolute -top-5 px-1.5 py-0.5 bg-bg-elevated text-[10px] text-ink-default rounded shadow-md pointer-events-none whitespace-nowrap"
              style={{ left: tooltip.x }}
            >
              {tooltip.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CelebrationBurst(): JSX.Element {
  const particles = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * 360;
    const distance = 40 + Math.random() * 30;
    return (
      <span
        key={i}
        className="absolute w-1.5 h-1.5 rounded-full"
        style={{
          left: '50%',
          top: '50%',
          backgroundColor: i % 3 === 0 ? '#1CE783' : i % 3 === 1 ? '#00D4AA' : '#9945FF',
          animation: `particle-burst 1s ease-out forwards`,
          animationDelay: `${i * 40}ms`,
          transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${distance}px)`,
          opacity: 0,
        }}
      />
    );
  });
  return <>{particles}</>;
}
