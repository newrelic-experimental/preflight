import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AlertBannerStack } from './AlertBannerStack';
import { useLiveStore, type AlertEvent } from '../store/liveStore';

function fireOne(overrides: Partial<AlertEvent>): void {
  useLiveStore.getState().addOrUpdateAlert({
    id: overrides.id ?? 'rule-x',
    state: 'firing',
    severity: 'warning',
    title: 'Rule',
    description: 'd',
    value: 1,
    threshold: 0,
    firedAt: 0,
    ...overrides,
  });
}

function resetStore(): void {
  useLiveStore.setState({
    connected: false,
    recentToolCalls: [],
    cost: null,
    antiPatterns: [],
    firingAlerts: new Map(),
    dismissedAlerts: new Set(),
  });
}

describe('AlertBannerStack', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    resetStore();
  });

  it('renders nothing when no alerts are firing', () => {
    const { container } = render(<AlertBannerStack />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one banner per firing alert (under collapse threshold)', () => {
    fireOne({ id: 'a', title: 'Rule A' });
    fireOne({ id: 'b', title: 'Rule B', firedAt: 100 });
    render(<AlertBannerStack />);
    expect(screen.getByText('Rule A')).toBeInTheDocument();
    expect(screen.getByText('Rule B')).toBeInTheDocument();
  });

  it('hides dismissed alerts from the rendered output', () => {
    fireOne({ id: 'a', title: 'Rule A' });
    fireOne({ id: 'b', title: 'Rule B' });
    useLiveStore.getState().dismissAlert('a');
    render(<AlertBannerStack />);
    expect(screen.queryByText('Rule A')).toBeNull();
    expect(screen.getByText('Rule B')).toBeInTheDocument();
  });

  it('orders critical alerts above warnings', () => {
    fireOne({ id: 'w', title: 'Warn rule', severity: 'warning', firedAt: 100 });
    fireOne({ id: 'c', title: 'Crit rule', severity: 'critical', firedAt: 50 });
    render(<AlertBannerStack />);
    const banners = screen.getAllByRole('alert');
    // The critical banner has role="alert"; the warning has role="status".
    expect(banners.length).toBe(1);
    expect(banners[0]!.textContent).toContain('Crit rule');
  });

  it('collapses to a count header when 5+ alerts are firing', () => {
    for (let i = 0; i < 5; i++) {
      fireOne({ id: `r-${i}`, title: `Rule ${i}` });
    }
    render(<AlertBannerStack />);
    // None of the per-alert banners are rendered yet.
    expect(screen.queryByText('Rule 0')).toBeNull();
    // Collapse header is present.
    const header = screen.getByRole('button', { name: /5 alerts firing — expand/ });
    expect(header).toBeInTheDocument();
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands the stack when the collapse header is clicked', () => {
    for (let i = 0; i < 6; i++) {
      fireOne({ id: `r-${i}`, title: `Rule ${i}` });
    }
    render(<AlertBannerStack />);
    fireEvent.click(screen.getByRole('button', { name: /6 alerts firing — expand/ }));
    expect(screen.getByText('Rule 0')).toBeInTheDocument();
    expect(screen.getByText('Rule 5')).toBeInTheDocument();
    const collapseHeader = screen.getByRole('button', { name: /6 alerts firing — collapse/ });
    expect(collapseHeader.getAttribute('aria-expanded')).toBe('true');
  });

  it('uses the highest severity for the collapse header tone', () => {
    fireOne({ id: '1', severity: 'info' });
    fireOne({ id: '2', severity: 'warning' });
    fireOne({ id: '3', severity: 'critical' });
    fireOne({ id: '4', severity: 'warning' });
    fireOne({ id: '5', severity: 'info' });
    render(<AlertBannerStack />);
    const header = screen.getByRole('button', { name: /5 alerts firing — expand/ });
    // Find the spoken severity dot — should carry the critical accent.
    const severityLabel = header.querySelector('span.font-semibold');
    expect(severityLabel?.className).toContain('text-accent-red');
  });

  it('clicking dismiss on a banner removes it from the visible list', () => {
    fireOne({ id: 'a', title: 'Rule A' });
    fireOne({ id: 'b', title: 'Rule B' });
    render(<AlertBannerStack />);
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss alert' });
    expect(dismissButtons.length).toBe(2);
    fireEvent.click(dismissButtons[0]!);
    expect(screen.getAllByRole('button', { name: 'Dismiss alert' }).length).toBe(1);
  });

  // Once the user expands a 5+ stack and the count drops below the
  // threshold (e.g., dismisses 2 down to 4), the expanded path renders
  // without a collapse button — there's no way to recollapse without
  // reloading the page. The fix resets `expanded` when count falls back
  // below the threshold so the next time it crosses, the stack starts
  // collapsed again.
  it('resets expanded state when count drops below the collapse threshold', () => {
    for (let i = 0; i < 6; i++) {
      fireOne({ id: `r-${i}`, title: `Rule ${i}` });
    }
    const { rerender } = render(<AlertBannerStack />);
    fireEvent.click(screen.getByRole('button', { name: /6 alerts firing — expand/ }));
    // Now expanded — all banners are visible plus the collapse header.
    expect(screen.getByText('Rule 0')).toBeInTheDocument();

    // User dismisses 2 alerts; count drops from 6 to 4 (below threshold).
    useLiveStore.getState().dismissAlert('r-0');
    useLiveStore.getState().dismissAlert('r-1');
    rerender(<AlertBannerStack />);
    expect(screen.getByText('Rule 2')).toBeInTheDocument();

    // The reset effect must hide the collapse-header button (count < threshold).
    expect(screen.queryByRole('button', { name: /alerts firing — collapse/ })).toBeNull();

    // Now five more rules fire — total is 9 (4 visible + 5 new − 0 dismissed).
    for (let i = 6; i < 11; i++) {
      fireOne({ id: `r-${i}`, title: `Rule ${i}` });
    }
    rerender(<AlertBannerStack />);
    // With 9 firing and expanded reset to false, we render the count header.
    expect(screen.getByRole('button', { name: /9 alerts firing — expand/ })).toBeInTheDocument();
  });
});
