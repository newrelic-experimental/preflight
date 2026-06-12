import { useState, useEffect, useRef } from 'react';
import { DiscreteBlockChart, type DiscreteBlockChartItem } from './DiscreteBlockChart';

import { Card, Eyebrow } from './ui';

export interface ConcurrencyData {
  readonly current: number;
  readonly peak: number;
  readonly allTimePeak?: number;
  readonly bucketSizeMs: number;
  readonly startTimestamp: number;
  readonly buckets: ReadonlyArray<{ timestamp: number; count: number }>;
}

const STORAGE_KEY = 'nr-observe-peak-concurrent';

export function ConcurrencyIndicator({
  current,
  peak,
  allTimePeak,
  buckets,
}: ConcurrencyData): JSX.Element {
  const [celebration, setCelebration] = useState(false);
  const prevPeakRef = useRef<number | null>(null);
  const hasData = buckets.some((b) => b.count > 0);

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

  const items: DiscreteBlockChartItem[] = buckets.map((bucket) => {
    const d = new Date(bucket.timestamp);
    const time = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return {
      count: bucket.count,
      tooltip: `${time} — ${bucket.count} concurrent`,
    };
  });

  return (
    <Card padding="sm" className={`relative overflow-hidden${celebration ? ' new-peak-glow' : ''}`}>
      {celebration && <CelebrationBurst />}
      <Eyebrow className="mb-1.5">Concurrent Sessions</Eyebrow>
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
        <div className="mt-2">
          <DiscreteBlockChart data={items} ariaLabel={`Concurrency over time, peak ${peak}`} />
        </div>
      )}
    </Card>
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
          // Hardcoded hex: short-lived celebration animation; light/dark divergence is acceptable.
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
