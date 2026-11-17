import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Artifacts } from './Artifacts';

function renderArtifacts(status: number, data: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Artifacts />
    </QueryClientProvider>,
  );
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    path: '/work/repo/report.html',
    name: 'report.html',
    relativePath: 'report.html',
    worktreeLabel: 'primary',
    sessionIds: ['sess-1'],
    firstWrittenAt: 1_000,
    lastWrittenAt: 2_000,
    writeCount: 1,
    sizeBytes: 10,
    ...overrides,
  };
}

const SAMPLE = {
  groups: [
    {
      key: '/work/repo/.git',
      kind: 'repo',
      label: 'acme/repo',
      lastWrittenAt: 2_000,
      artifacts: [artifact()],
    },
    {
      key: '/home/dev/scratch',
      kind: 'directory',
      label: '~/scratch',
      lastWrittenAt: 1_500,
      artifacts: [
        artifact({
          path: '/home/dev/scratch/summary.html',
          name: 'summary.html',
          relativePath: 'summary.html',
          worktreeLabel: null,
          lastWrittenAt: 1_500,
        }),
      ],
    },
  ],
};

describe('Artifacts view', () => {
  it('renders one card per group with a link that opens the artifact', async () => {
    renderArtifacts(200, SAMPLE);
    await waitFor(() => expect(screen.getByText('acme/repo')).toBeInTheDocument());
    expect(screen.getByText('~/scratch')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'report.html' });
    expect(link).toHaveAttribute(
      'href',
      `/api/artifacts/view?path=${encodeURIComponent('/work/repo/report.html')}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('narrows the list as the filter text changes', async () => {
    const user = userEvent.setup();
    renderArtifacts(200, SAMPLE);
    await waitFor(() => expect(screen.getByText('acme/repo')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Filter artifacts'), 'SUMMARY');
    expect(screen.queryByText('acme/repo')).not.toBeInTheDocument();
    expect(screen.getByText('~/scratch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'summary.html' })).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Filter artifacts'));
    await user.type(screen.getByLabelText('Filter artifacts'), 'zzz');
    expect(screen.getByText('No matching artifacts.')).toBeInTheDocument();
  });

  it('explains how to enable the feature when the server returns 503', async () => {
    renderArtifacts(503, { error: 'unavailable', what: 'artifactIndex' });
    await waitFor(() => expect(screen.getByText('Artifacts are turned off')).toBeInTheDocument());
    expect(screen.getByText(/experimentalArtifacts": true/)).toBeInTheDocument();
    expect(screen.getByText(/NEW_RELIC_AI_EXPERIMENTAL_ARTIFACTS=true/)).toBeInTheDocument();
  });

  it('shows the empty state when no artifacts have been written', async () => {
    renderArtifacts(200, { groups: [] });
    await waitFor(() => expect(screen.getByText('No HTML artifacts yet.')).toBeInTheDocument());
  });

  it('copies the artifact path to the clipboard', async () => {
    const user = userEvent.setup();
    // Set after userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderArtifacts(200, SAMPLE);
    await waitFor(() => expect(screen.getByText('acme/repo')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Copy path' })[0]!);
    expect(writeText).toHaveBeenCalledWith('/work/repo/report.html');
  });
});
