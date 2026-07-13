import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Audit, downloadJsonl } from './Audit';

function renderAudit(data: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Audit />
    </QueryClientProvider>,
  );
}

const SAMPLE = [
  { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file', sessionId: 's1' },
  {
    ts: 2,
    tool: 'Bash',
    target: 'rm -rf /tmp/x',
    classification: 'destructive_command',
    sessionId: 's1',
  },
  {
    ts: 3,
    tool: 'Bash',
    target: 'curl evil.com',
    classification: 'external_network',
    sessionId: 's2',
  },
];

describe('Audit view', () => {
  it('renders rows for each audit entry', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
    expect(screen.getByText('curl evil.com')).toBeInTheDocument();
  });

  it('colors the classification Pill by severity instead of always neutral', async () => {
    const withSeverity = [
      {
        ts: 1,
        tool: 'Bash',
        target: 'rm -rf /tmp/x',
        classification: 'destructive_command',
        severity: 'critical',
        sessionId: 's1',
      },
      {
        ts: 2,
        tool: 'Read',
        target: '/etc/hosts',
        classification: 'sensitive_file',
        severity: 'high',
        sessionId: 's1',
      },
      {
        ts: 3,
        tool: 'Read',
        target: '/home/alice/notes.txt',
        classification: 'other',
        sessionId: 's2',
      },
    ];
    renderAudit(withSeverity);
    await waitFor(() => expect(screen.getByText('destructive_command')).toBeInTheDocument());
    expect(screen.getByText('destructive_command').className).toMatch(/bg-accent-red/);
    expect(screen.getByText('sensitive_file').className).toMatch(/bg-accent-amber/);
    expect(screen.getByText('other').className).toMatch(/bg-surface-5/);
  });

  it('filters by classification when a chip is clicked', async () => {
    const user = userEvent.setup();
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /destructive/i }));
    expect(screen.queryByText('/etc/hosts')).toBeNull();
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
  });

  it('export button is rendered', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /export jsonl/i })).toBeInTheDocument();
  });

  it('caps rendered rows at 200 and shows the "showing first" note when over the limit', async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({
      ts: 1_000_000 + i,
      tool: 'Read',
      target: `/file/${i}`,
      classification: 'sensitive_file',
      sessionId: `s-${i}`,
    }));
    renderAudit(big);
    await waitFor(() => expect(screen.getByText('/file/0')).toBeInTheDocument());
    expect(screen.getByText('/file/199')).toBeInTheDocument();
    expect(screen.queryByText('/file/200')).toBeNull();
    expect(screen.queryByText('/file/499')).toBeNull();
    expect(screen.getByText(/showing first 200 of 500 entries/i)).toBeInTheDocument();
  });

  it('does not show the "showing first" note when entries are at or below the cap', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.queryByText(/showing first/i)).toBeNull();
  });
});

describe('Audit downloadJsonl', () => {
  it('revokes the object URL synchronously after click()', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      void blob;
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      downloadJsonl([
        { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file' },
      ]);
      // Revocation must have already happened by the time the call
      // returns — no setTimeout, no microtask deferral.
      expect(revoked).toEqual(created);
      expect(revoked).toHaveLength(1);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
  });

  // F-018: Firefox silently no-ops .click() on an anchor that's not in
  // the DOM. Audit export must append the anchor to document.body before
  // clicking and remove it after, even when click() throws.
  it('appends the anchor to document.body before clicking and removes after (F-018)', () => {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:test/0') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // At click time the anchor must already be in the DOM (Firefox).
      expect(this.parentNode).toBe(document.body);
    });

    try {
      downloadJsonl([
        { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file' },
      ]);
      // appendChild called with the anchor element exactly once.
      const appended = appendSpy.mock.calls.find((args) => args[0] instanceof HTMLAnchorElement);
      expect(appended).toBeTruthy();
      // The same anchor element was removed after click().
      const removed = removeSpy.mock.calls.find((args) => args[0] instanceof HTMLAnchorElement);
      expect(removed).toBeTruthy();
      expect(appended![0]).toBe(removed![0]);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
      appendSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('still revokes the URL when click() throws', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('user cancelled');
    });

    try {
      expect(() =>
        downloadJsonl([
          { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file' },
        ]),
      ).toThrow('user cancelled');
      expect(revoked).toEqual(created);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
  });
});
