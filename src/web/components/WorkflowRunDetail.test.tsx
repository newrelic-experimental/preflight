import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkflowRunDetail } from './WorkflowRunDetail';
import type { WorkflowRunDetailResponse, WorkflowRunInfo } from '../api/client';

function makeRun(overrides: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
  return {
    runId: 'run-1',
    parentSessionId: 'session-1',
    taskId: null,
    workflowName: 'My Workflow',
    status: 'completed',
    defaultModel: 'claude-sonnet',
    ...overrides,
  };
}

function stubDetailResponse(response: WorkflowRunDetailResponse): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof fetch;
}

function renderRunDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowRunDetail runId="run-1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('WorkflowRunDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the failure reason for a failed run with a non-empty errorReason', async () => {
    stubDetailResponse({
      run: makeRun({ status: 'failed', errorReason: 'Agent crashed on tool call' }),
      agents: [],
      topology: null,
    });
    renderRunDetail();
    await waitFor(() => expect(screen.getByText('Failure reason')).toBeInTheDocument());
    expect(screen.getByText('Agent crashed on tool call')).toBeInTheDocument();
  });

  it('does not render a failure reason for a completed run, even with a stray errorReason', async () => {
    stubDetailResponse({
      run: makeRun({ status: 'completed', errorReason: 'this should be ignored' }),
      agents: [],
      topology: null,
    });
    renderRunDetail();
    await waitFor(() => expect(screen.getByText('My Workflow')).toBeInTheDocument());
    expect(screen.queryByText('Failure reason')).not.toBeInTheDocument();
    expect(screen.queryByText('this should be ignored')).not.toBeInTheDocument();
  });
});
