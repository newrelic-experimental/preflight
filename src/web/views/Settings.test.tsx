import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from './Settings.js';

vi.mock('../api/client', () => ({
  fetchSettings: vi.fn(async () => ({
    developer: 'dev',
    teamId: null,
    accountId: null,
    appName: 'preflight',
    mode: 'local',
    storagePath: '~/.newrelic-preflight',
    highSecurity: false,
    licenseKey: null,
    sessionBudgetUsd: null,
    dailyBudgetUsd: null,
    weeklyBudgetUsd: null,
    retainSessionsDays: null,
  })),
  fetchDiagnostics: vi.fn(async () => []),
  patchSettings: vi.fn(async () => ({})),
  qk: {
    settings: ['settings'],
    diagnostics: ['diagnostics'],
  },
}));

import * as client from '../api/client';

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('DiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "System healthy" when all checks are ok', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      { check: 'Config valid', status: 'ok', detail: 'Config loaded' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/system healthy/i)).toBeTruthy();
  });

  it('renders failing check name and detail when a check fails', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      {
        check: 'Hooks wired',
        status: 'fail',
        detail: 'PreToolUse missing',
        fix: 'preflight install',
      },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/Hooks wired/)).toBeTruthy();
    expect(await screen.findByText(/PreToolUse missing/)).toBeTruthy();
    expect(await screen.findByText(/preflight install/)).toBeTruthy();
  });

  it('renders warning check with amber indicator', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      { check: 'Config valid', status: 'warn', detail: 'Unknown key "foo"' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/Unknown key/)).toBeTruthy();
  });

  it('renders skip check detail alongside a failing check', async () => {
    vi.mocked(client.fetchDiagnostics).mockResolvedValue([
      {
        check: 'Hooks wired',
        status: 'fail',
        detail: 'PreToolUse missing',
        fix: 'preflight install',
      },
      { check: 'Daemon installed', status: 'skip', detail: 'macOS only' },
    ] as never);
    wrap(<Settings />);
    expect(await screen.findByText(/macOS only/)).toBeTruthy();
  });
});
