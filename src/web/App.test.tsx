import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { useLiveStore, type AlertEvent } from './store/liveStore';

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

function fireOne(overrides: Partial<AlertEvent> = {}): void {
  useLiveStore.getState().addOrUpdateAlert({
    id: 'rule-x',
    state: 'firing',
    severity: 'critical',
    title: 'Critical rule',
    description: 'crit',
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

describe('App shell', () => {
  beforeEach(() => {
    resetStore();
    (globalThis as { EventSource: unknown }).EventSource = class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    };
    // Today.tsx mounts the Recent Alerts panel which fetches /api/alerts/recent
    // via React Query. Stub fetch so the test environment doesn't try to
    // hit a real endpoint or warn about un-acted async state updates.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
  });
  afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('renders the sidebar', () => {
    renderApp();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit' })).toBeInTheDocument();
  });

  it('renders the Today view by default', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: /today/i })).toBeInTheDocument();
  });

  it('does not render any alert banner when none are firing', () => {
    renderApp();
    // Critical banners use role="alert"; warnings/info use role="status".
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders a banner stack at the SPA root when an alert is firing', () => {
    fireOne({ id: 'r1', title: 'Boom', severity: 'critical' });
    renderApp();
    const banner = screen.getByRole('alert');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('Boom');
  });
});
