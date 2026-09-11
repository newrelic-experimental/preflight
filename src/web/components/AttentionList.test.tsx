import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AttentionList, humanizeFlagType, type AttentionRow } from './AttentionList';

function makeRow(overrides: Partial<AttentionRow> = {}): AttentionRow {
  return { type: 're_reading', count: 7, targets: [], sessionIds: [], ...overrides };
}

describe('humanizeFlagType()', () => {
  it('maps every known type to its label', () => {
    expect(humanizeFlagType('over_delegation')).toBe('Over-delegation');
    expect(humanizeFlagType('re_reading')).toBe('Repeated reads');
    expect(humanizeFlagType('stuck_loop')).toBe('Stuck loop');
    expect(humanizeFlagType('blind_editing')).toBe('Blind editing');
    expect(humanizeFlagType('thrashing')).toBe('Edit/test thrashing');
  });

  it('falls back to spaced, capitalized text for an unknown type', () => {
    expect(humanizeFlagType('slow_startup')).toBe('Slow startup');
  });
});

describe('AttentionList', () => {
  it('renders the label with its count and the advice for a known type', () => {
    render(<AttentionList rows={[makeRow()]} firingCount={0} alertsHref="/alerts" />);
    expect(screen.getByText('Repeated reads ×7')).toBeInTheDocument();
    expect(screen.getByText(/Read a file once/)).toBeInTheDocument();
  });

  it('shows up to three target basenames and counts the rest', () => {
    render(
      <AttentionList
        rows={[makeRow({ targets: ['/a/one.ts', '/b/two.ts', '/c/three.ts', '/d/four.ts'] })]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('one.ts · two.ts · three.ts +1 more')).toBeInTheDocument();
  });

  it('links to the contributing sessions', () => {
    render(
      <AttentionList
        rows={[makeRow({ sessionIds: ['s1', 's2'] })]}
        firingCount={0}
        alertsHref="/alerts"
      />,
    );
    expect(screen.getByText('View sessions →')).toHaveAttribute(
      'href',
      '/sessions?sessionIds=s1,s2',
    );
  });

  it('omits the sessions link and the target line when there is nothing to show', () => {
    render(<AttentionList rows={[makeRow()]} firingCount={0} alertsHref="/alerts" />);
    expect(screen.queryByText('View sessions →')).toBeNull();
    expect(screen.queryByText(/\.ts/)).toBeNull();
  });

  it('renders the firing count as a link to alertsHref', () => {
    render(<AttentionList rows={[]} firingCount={2} alertsHref="/alerts" />);
    expect(screen.getByText('2 firing')).toHaveAttribute('href', '/alerts');
  });

  it('renders the inline empty text when there are no rows and nothing firing', () => {
    render(<AttentionList rows={[]} firingCount={0} alertsHref="/alerts" />);
    expect(screen.getByText(/Nothing needs attention/)).toBeInTheDocument();
  });
});
