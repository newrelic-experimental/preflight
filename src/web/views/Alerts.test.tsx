import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { Alerts } from './Alerts';

const DEFAULT_BUDGET = {
  session: { budgetUsd: null, spentUsd: 0, pctUsed: null, exceeded: false },
  daily: { budgetUsd: null, spentUsd: 0, pctUsed: null, exceeded: false },
  weekly: { budgetUsd: null, spentUsd: 0, pctUsed: null, exceeded: false },
  alerts: [],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAlerts(initialSettings: {
  digestWebhookUrl: string | null;
  digestSchedule: string;
  alerts: { personal: Record<string, number> };
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  let settings = initialSettings;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/budget') return jsonResponse(DEFAULT_BUDGET);
    if (url === '/api/settings' && (!init || init.method === undefined)) {
      return jsonResponse(settings);
    }
    if (url === '/api/settings' && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      settings = { ...settings, ...patch } as typeof settings;
      return jsonResponse({ ok: true, restartRequired: false });
    }
    return jsonResponse({});
  }) as typeof fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Alerts />
    </QueryClientProvider>,
  );
}

const BASE_SETTINGS = {
  digestWebhookUrl: 'https://hooks.slack.com/services/original',
  digestSchedule: '0 9 * * 1',
  alerts: {
    personal: {
      dailyCostUsd: 10,
      sessionCostUsd: 5,
      efficiencyScoreMin: 0.5,
      stuckLoopCountMax: 3,
      antiPatternCountMax: 5,
    },
  },
};

describe('Alerts view', () => {
  it('does not claim these thresholds feed a local alert engine or need a server restart', async () => {
    renderAlerts(BASE_SETTINGS);
    await waitFor(() => expect(screen.getByText(/Alert Thresholds/)).toBeInTheDocument());
    expect(screen.queryByText(/local alert engine/i)).toBeNull();
    expect(screen.queryByText(/require a server restart/i)).toBeNull();
  });

  it('resets the webhook input to server truth after clicking Unsubscribe', async () => {
    renderAlerts(BASE_SETTINGS);
    const input = await screen.findByPlaceholderText('https://hooks.slack.com/...');
    fireEvent.change(input, { target: { value: 'https://hooks.slack.com/unsaved-edit' } });
    expect(input).toHaveValue('https://hooks.slack.com/unsaved-edit');

    const unsubscribeButton = screen.getByRole('button', { name: 'Unsubscribe' });
    fireEvent.click(unsubscribeButton);

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());
    expect(input).toHaveValue('');
  });
});
