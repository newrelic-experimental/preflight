import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { UsageReportsBanner } from './UsageReportsBanner';

const view = {
  state: 'unset' as const,
  description: 'not set: nothing is sent until you choose',
  canAsk: true,
  summary: ['Which Preflight features are turned on', 'A random install ID'],
  neverSent: 'Never your code.',
  privacyUrl: 'https://example.test/PRIVACY.md#usage-reports-opt-in',
  showCommand: 'preflight usage-reports show',
};

vi.mock('../api/client', () => ({
  fetchSettings: vi.fn(async () => ({ usageReports: view })),
  patchSettings: vi.fn(async () => ({})),
  qk: { settings: ['settings'] },
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsageReportsBanner />
    </QueryClientProvider>,
  );
}

describe('UsageReportsBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows what a report holds, from the server, when asked', async () => {
    wrap();
    const toggle = await screen.findByRole('button', { name: /what’s sent/i });
    expect(screen.queryByText(view.summary[0]!)).toBeNull();
    fireEvent.click(toggle);
    for (const line of view.summary) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(view.neverSent)).toBeTruthy();
    expect(screen.getByRole('link', { name: /full list of fields/i }).getAttribute('href')).toBe(
      view.privacyUrl,
    );
    expect(screen.getByText(view.showCommand)).toBeTruthy();
  });
});
