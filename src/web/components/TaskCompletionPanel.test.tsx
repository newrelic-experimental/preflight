import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskCompletionPanel } from './TaskCompletionPanel';
import type { TaskCompletionMetrics } from '../api/client';

function stubTaskCompletion(body: TaskCompletionMetrics): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
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

  it('shows a single completed task with its own averages', async () => {
    stubTaskCompletion({ completedTasks: 1, avgTaskDurationMs: 42_000, avgToolCallsPerTask: 3 });
    renderPanel();

    expect(await screen.findByText('42s')).toBeTruthy();
    expect(screen.getByText('3.0')).toBeTruthy();
    expect(screen.queryByText(/No completed tasks yet/)).toBeNull();
  });

  it('requests the task-completion route', async () => {
    const fetchMock = stubTaskCompletion({
      completedTasks: 2,
      avgTaskDurationMs: 120_000,
      avgToolCallsPerTask: 7,
    });
    renderPanel();

    await screen.findByText('2');
    expect(fetchMock).toHaveBeenCalledWith('/api/task-completion', expect.anything());
  });

  it('refetches on an interval so the numbers stay current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = stubTaskCompletion({
        completedTasks: 1,
        avgTaskDurationMs: 42_000,
        avgToolCallsPerTask: 3,
      });
      renderPanel();

      await screen.findByText('42s');
      const before = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the empty state when no task has completed', async () => {
    stubTaskCompletion({ completedTasks: 0, avgTaskDurationMs: null, avgToolCallsPerTask: null });
    renderPanel();

    expect(await screen.findByText(/No completed tasks yet/)).toBeTruthy();
    expect(screen.queryByText('avg duration')).toBeNull();
  });

  it('shows an unavailable state, not the empty state, when the route returns 503', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    ) as typeof fetch;
    renderPanel();

    expect(await screen.findByText(/Task stats unavailable/)).toBeTruthy();
    expect(screen.queryByText(/No completed tasks yet/)).toBeNull();
  });
});
