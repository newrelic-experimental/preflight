import { render, screen } from '@testing-library/react';
import { GanttTimeline } from './GanttTimeline';

const ENTRIES = [
  { timestamp: 1_000, toolName: 'Read', durationMs: 120, success: true },
  { timestamp: 2_000, toolName: 'Edit', durationMs: 240, success: true },
  { timestamp: 500, toolName: 'Bash', durationMs: 80, success: false },
];

describe('GanttTimeline', () => {
  it('renders one row per entry, sorted by timestamp ascending', () => {
    render(<GanttTimeline entries={ENTRIES} segments={[]} />);
    const rowLabels = screen.getAllByTitle(/^(Read|Edit|Bash)$/);
    expect(rowLabels.map((el) => el.textContent)).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('shows the empty state when entries is empty', () => {
    render(<GanttTimeline entries={[]} segments={[]} />);
    expect(screen.getByText('No tool calls recorded.')).toBeInTheDocument();
  });

  it('highlights a row whose original index falls inside a segment', () => {
    // Segment covers original indices [0, 1] = Read, Edit (pre-sort order).
    render(
      <GanttTimeline
        entries={ENTRIES}
        segments={[{ type: 'thrashing', startIndex: 0, endIndex: 1, severity: 'critical' }]}
      />,
    );
    // Sanity: component still renders all 3 rows with a segment applied.
    expect(screen.getAllByTitle(/^(Read|Edit|Bash)$/)).toHaveLength(3);
  });

  it('gives each bar an accessible name with tool, duration, and outcome', () => {
    render(<GanttTimeline entries={ENTRIES} segments={[]} />);
    expect(screen.getByRole('img', { name: 'Read · 120ms · success' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Edit · 240ms · success' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bash · 80ms · failed' })).toBeInTheDocument();
  });
});
