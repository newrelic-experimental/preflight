import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskCompletionPanel } from './TaskCompletionPanel';
import type { TaskCompletionMetrics } from '../api/client';

function stubTaskCompletion(body: TaskCompletionMetrics): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof fetch;
}

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <TaskCompletionPanel />
    </QueryClientProvider>,
  );
}

describe('TaskCompletionPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows completed count, average duration, and average tool calls per task', async () => {
    stubTaskCompletion({ completedTasks: 2, avgTaskDurationMs: 120_000, avgToolCallsPerTask: 7 });
    renderPanel();

    expect(await screen.findByText('2')).toBeTruthy();
    expect(screen.getByText('2m')).toBeTruthy();
    expect(screen.getByText('7.0')).toBeTruthy();
    expect(screen.queryByText(/No completed tasks yet/)).toBeNull();
  });

  it('renders the empty state when no task has completed', async () => {
    stubTaskCompletion({ completedTasks: 0, avgTaskDurationMs: null, avgToolCallsPerTask: null });
    renderPanel();

    expect(await screen.findByText(/No completed tasks yet/)).toBeTruthy();
    expect(screen.queryByText('avg duration')).toBeNull();
  });
});
