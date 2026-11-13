import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigestPreviewDialog } from './DigestPreviewDialog';

const PREVIEW_TEXT = 'Weekly AI Coding Summary\nTotal Cost: $1.0000';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderDialog(opts: { webhookConfigured: boolean; sendResult?: unknown }) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/digest/preview') {
      return jsonResponse({
        content: [{ type: 'text', text: JSON.stringify({ week: '2026-W45', text: PREVIEW_TEXT }) }],
      });
    }
    if (url === '/api/digest/send') {
      return jsonResponse(
        opts.sendResult ?? {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, message: 'Digest sent successfully.' }),
            },
          ],
        },
      );
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <DigestPreviewDialog webhookConfigured={opts.webhookConfigured} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { calls, onClose };
}

describe('DigestPreviewDialog', () => {
  it('opens as a dialog and renders the preview text for the current week', async () => {
    renderDialog({ webhookConfigured: true });
    expect(screen.getByRole('dialog', { name: 'Digest preview' })).toBeTruthy();
    expect(await screen.findByText(/Total Cost: \$1\.0000/)).toBeTruthy();
    expect(screen.getByText(/Week 2026-W45/)).toBeTruthy();
  });

  it('sends through the existing send route when Send now is clicked', async () => {
    const { calls } = renderDialog({ webhookConfigured: true });
    const sendButton = await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Digest sent.');
    expect(calls).toContainEqual({ url: '/api/digest/send', method: 'POST' });
  });

  it('shows the send error text when the send route reports one', async () => {
    renderDialog({
      webhookConfigured: true,
      sendResult: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Slack webhook returned 500' }) }],
      },
    });
    const sendButton = await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sendButton);
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Slack webhook returned 500',
    );
  });

  it('disables Send now and explains why when no webhook is configured', async () => {
    const { calls } = renderDialog({ webhookConfigured: false });
    const sendButton = await screen.findByRole('button', { name: 'Send now' });
    await screen.findByText(/Total Cost: \$1\.0000/);
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Save a webhook URL to send.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/digest/send')).toBe(false);
  });

  it('closes from the Close button and from the Escape key', async () => {
    const { onClose } = renderDialog({ webhookConfigured: true });
    await screen.findByText(/Total Cost: \$1\.0000/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
