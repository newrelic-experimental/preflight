import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  fetchObservabilityHealth: vi.fn(async () => ({
    watcherActive: true,
    filesWatched: 3,
    parseErrors: 0,
  })),
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

describe('Subagent watcher status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows disabled when the observability-health endpoint reports watcherActive: false', async () => {
    vi.mocked(client.fetchObservabilityHealth).mockResolvedValue({
      watcherActive: false,
      filesWatched: 0,
      parseErrors: 0,
    });
    wrap(<Settings />);
    // The "High security" read-only field also renders the literal text
    // "disabled" (from the mocked highSecurity: false setting), so scope
    // the query to the watcher status's own red-text span.
    expect(
      await screen.findByText('disabled', { selector: '.text-accent-red' }),
    ).toBeInTheDocument();
  });

  it('shows enabled with file/error counts when watcherActive is true', async () => {
    vi.mocked(client.fetchObservabilityHealth).mockResolvedValue({
      watcherActive: true,
      filesWatched: 5,
      parseErrors: 1,
    });
    wrap(<Settings />);
    expect(await screen.findByText('enabled')).toBeInTheDocument();
    expect(await screen.findByText(/5 files watched, 1 parse errors/i)).toBeInTheDocument();
  });
});

describe('Identity & Account save flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves an edited developer name and shows the restart banner', async () => {
    wrap(<Settings />);
    const input = await screen.findByDisplayValue('dev');
    fireEvent.change(input, { target: { value: 'newdev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(client.patchSettings).toHaveBeenCalledWith({ developer: 'newdev' }));
    expect(
      await screen.findByText('Saved. Restart the server for changes to take effect.'),
    ).toBeInTheDocument();
  });

  it('shows the red saveError banner when the save mutation rejects', async () => {
    vi.mocked(client.patchSettings).mockRejectedValueOnce(new Error('disk full'));
    wrap(<Settings />);
    const input = await screen.findByDisplayValue('dev');
    fireEvent.change(input, { target: { value: 'newdev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
  });
});
