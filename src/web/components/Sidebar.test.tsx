import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar, type SidebarProps } from './Sidebar';
import { useLiveStore, type AlertEvent } from '../store/liveStore';
import { useVersionInfo } from '../hooks/useVersionInfo';

vi.mock('../hooks/useVersionInfo.js', () => ({
  useVersionInfo: vi.fn(),
}));

const mockVersionInfo = useVersionInfo as ReturnType<typeof vi.fn>;

function fireOne(overrides: Partial<AlertEvent> = {}): void {
  useLiveStore.getState().addOrUpdateAlert({
    id: 'rule-x',
    state: 'firing',
    severity: 'warning',
    title: 'Rule',
    description: '',
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

function renderSidebar(overrides: Partial<SidebarProps> = {}): void {
  render(
    <Sidebar
      currentPath="/"
      onNavigate={() => {}}
      connected={true}
      theme="dark"
      onToggleTheme={() => {}}
      {...overrides}
    />,
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    resetStore();
    mockVersionInfo.mockReturnValue({ installed: null, latest: null, updateAvailable: false });
  });
  afterEach(() => {
    resetStore();
  });

  it('renders all four nav items', () => {
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('highlights the active item', () => {
    render(
      <Sidebar
        currentPath="/audit"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const audit = screen.getByText('Audit').closest('button');
    expect(audit).toHaveAttribute('aria-current', 'page');
  });

  it('shows ● connected when connected=true', () => {
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByText(/live/i)).toBeInTheDocument();
  });

  it('shows ● reconnecting when connected=false', () => {
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={false}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('does not set aria-current on inactive items', () => {
    render(
      <Sidebar
        currentPath="/audit"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    for (const label of ['Today', 'Sessions', 'History']) {
      const btn = screen.getByText(label).closest('button')!;
      expect(btn.hasAttribute('aria-current')).toBe(false);
    }
  });

  it('marks decorative icons aria-hidden inside nav buttons', () => {
    const { container } = render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const icons = container.querySelectorAll('nav button svg');
    expect(icons.length).toBe(7);
    for (const svg of Array.from(icons)) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('labels the nav landmarks as "Observe" and "Analyze"', () => {
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Observe' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Analyze' })).toBeInTheDocument();
  });

  it('does not render an alert badge when no alerts are firing', () => {
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.queryByTestId('alert-badge')).toBeNull();
  });

  it('shows a numeric badge on Today when alerts are firing', () => {
    fireOne({ id: 'a', severity: 'warning' });
    fireOne({ id: 'b', severity: 'warning' });
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const badge = screen.getByTestId('alert-badge');
    expect(badge.textContent).toBe('2');
    expect(badge).toHaveAttribute('aria-label', '2 firing alerts');
  });

  it('uses a singular aria-label when there is one alert', () => {
    fireOne({ id: 'a', severity: 'warning' });
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByTestId('alert-badge')).toHaveAttribute('aria-label', '1 firing alert');
  });

  it('tones the badge with the highest severity present', () => {
    fireOne({ id: 'a', severity: 'warning' });
    fireOne({ id: 'b', severity: 'critical' });
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const badge = screen.getByTestId('alert-badge');
    expect(badge.getAttribute('data-severity')).toBe('critical');
    expect(badge.className).toContain('text-accent-red');
  });

  it('caps the badge text at 99+ when alert count exceeds 99', () => {
    for (let i = 0; i < 100; i += 1) {
      fireOne({ id: `alert-${i}`, severity: 'warning' });
    }
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const badge = screen.getByTestId('alert-badge');
    expect(badge.textContent).toBe('99+');
    expect(badge).toHaveAttribute('aria-label', '99+ firing alerts');
  });

  it('shows the raw count for badges at or below 99', () => {
    for (let i = 0; i < 99; i += 1) {
      fireOne({ id: `alert-${i}`, severity: 'warning' });
    }
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByTestId('alert-badge').textContent).toBe('99');
  });

  it('only shows the badge on the Today nav item, not on others', () => {
    fireOne({ id: 'a', severity: 'warning' });
    render(
      <Sidebar
        currentPath="/"
        onNavigate={() => {}}
        connected={true}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    const todayBtn = screen.getByText('Today').closest('button')!;
    expect(todayBtn.querySelector('[data-testid="alert-badge"]')).not.toBeNull();
    for (const label of ['Sessions', 'History', 'Audit']) {
      const btn = screen.getByText(label).closest('button')!;
      expect(btn.querySelector('[data-testid="alert-badge"]')).toBeNull();
    }
  });

  it('renders the version number when installed is set', () => {
    mockVersionInfo.mockReturnValue({ installed: '1.0.4', latest: null, updateAvailable: false });
    renderSidebar();
    expect(screen.getByText('v1.0.4')).toBeInTheDocument();
  });

  it('renders a GitHub link pointing to the public repo', () => {
    mockVersionInfo.mockReturnValue({ installed: '1.0.4', latest: null, updateAvailable: false });
    renderSidebar();
    const link = screen.getByRole('link', { name: /github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/newrelic-experimental/preflight');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides the version row when installed is null', () => {
    mockVersionInfo.mockReturnValue({ installed: null, latest: null, updateAvailable: false });
    renderSidebar();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it('shows update nudge when updateAvailable is true', () => {
    mockVersionInfo.mockReturnValue({ installed: '1.0.4', latest: '1.0.5', updateAvailable: true });
    renderSidebar();
    expect(screen.getByText('v1.0.5 available')).toBeInTheDocument();
  });

  it('hides update nudge when updateAvailable is false', () => {
    mockVersionInfo.mockReturnValue({
      installed: '1.0.4',
      latest: '1.0.5',
      updateAvailable: false,
    });
    renderSidebar();
    expect(screen.queryByText(/available/)).not.toBeInTheDocument();
  });
});
