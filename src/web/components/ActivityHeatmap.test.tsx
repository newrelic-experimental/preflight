import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ActivityHeatmap } from './ActivityHeatmap';

describe('ActivityHeatmap grid variant — timezone handling', () => {
  const originalTZ = process.env.TZ;

  beforeEach(() => {
    // This bug only manifests west of UTC. Force a fixed negative-offset
    // zone so this test is deterministic regardless of the CI/dev machine's
    // ambient timezone (which may default to UTC, where the bug is invisible).
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it('places a UTC day-key in its correct weekday row, not one day early', () => {
    // '2026-07-08' is a UTC-anchored day key from the backend (see
    // api-handler.ts's /api/activity-heatmap history-view handler) — it
    // is a real Wednesday (getUTCDay() === 3). The buggy local .getDay()
    // reads it as Tuesday (getDay() === 2 in America/New_York) instead.
    const { container } = render(
      <ActivityHeatmap
        variant="grid"
        buckets={[]}
        maxCount={5}
        days={[{ date: '2026-07-08', count: 5 }]}
      />,
    );
    const rect = container.querySelector('rect');
    expect(rect).not.toBeNull();
    // row = (getUTCDay() + 6) % 7 = (3 + 6) % 7 = 2 (Wednesday's row).
    // cellSize=10, cellGap=2, headerHeight=14 → y = 14 + 2*(10+2) = 38.
    // The buggy local-accessor version would place this at row 1 (y=26),
    // one row earlier (Tuesday's row).
    expect(rect).toHaveAttribute('y', '38');
  });
});
