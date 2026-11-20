import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { UsageReportsPanel } from './UsageReportsPanel';
import * as client from '../api/client';

vi.mock('../api/client', () => ({
  fetchSettings: vi.fn(async () => ({
    usageReports: {
      state: 'on',
      description: 'on: you said yes',
      canAsk: false,
      summary: ['How many Preflight sessions ran each day'],
      neverSent: 'Never your code.',
      privacyUrl: 'https://example.test/PRIVACY.md',
      showCommand: 'preflight usage-reports show',
    },
  })),
  fetchUsageReportsPreview: vi.fn(async () => ({
    start: [{ event: 'preflight/install reported', anonymousId: 'id-1' }],
    queued: [{ date: '2026-11-20', today: true, events: [{ event: 'preflight/tool called' }] }],
    sent: [{ sentAt: '2026-11-19T01:00:00.000Z', event: { event: 'preflight/usage reported' } }],
    sentTotal: 1,
  })),
  qk: { settings: ['settings'], usageReportsPreview: ['usage-reports', 'preview'] },
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsageReportsPanel />
    </QueryClientProvider>,
  );
}

describe('UsageReportsPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the setting and what a report holds', async () => {
    wrap();
    expect(await screen.findByText('on: you said yes')).toBeTruthy();
    expect(screen.getByText('How many Preflight sessions ran each day')).toBeTruthy();
    expect(client.fetchUsageReportsPreview).not.toHaveBeenCalled();
  });

  it('loads the exact payloads only when asked', async () => {
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: /show exact payloads/i }));
    expect(await screen.findByText(/preflight\/install reported/)).toBeTruthy();
    expect(screen.getByText(/today, still counting/)).toBeTruthy();
    expect(screen.getByText(/1 event, newest last/)).toBeTruthy();
    expect(screen.getByText(/preflight\/usage reported/)).toBeTruthy();
  });
});
