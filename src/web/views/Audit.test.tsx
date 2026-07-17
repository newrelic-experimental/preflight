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
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    const table = screen.getByRole('table');
    const destructivePills = Array.from(table.querySelectorAll('td'))
      .find((td) => td.textContent?.includes('Destructive'))
      ?.querySelector('span');
    const sensitivePills = Array.from(table.querySelectorAll('td'))
      .find((td) => td.textContent?.includes('Sensitive files'))
      ?.querySelector('span');
    const otherPills = Array.from(table.querySelectorAll('td'))
      .find((td) => td.textContent?.includes('other'))
      ?.querySelector('span');
    expect(destructivePills?.className).toMatch(/bg-accent-red/);
    expect(sensitivePills?.className).toMatch(/bg-accent-amber/);
    expect(otherPills?.className).toMatch(/bg-surface-5/);
  });

  it('renders friendly classification labels, not raw keys', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getAllByText('Sensitive files').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Destructive').length).toBeGreaterThan(0);
    expect(screen.getAllByText('External network').length).toBeGreaterThan(0);
    expect(screen.queryByText('sensitive_file')).toBeNull();
    expect(screen.queryByText('destructive_command')).toBeNull();
    expect(screen.queryByText('external_network')).toBeNull();
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

  it('shows an error message when the audit log fetch fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    globalThis.fetch = (() =>
      Promise.resolve(new Response('Internal Server Error', { status: 500 }))) as typeof fetch;
    render(
      <QueryClientProvider client={qc}>
        <Audit />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Error loading audit log.')).toBeInTheDocument();
  });

  it('shows "No matching entries." for a genuinely empty dataset', async () => {
    renderAudit([]);
    expect(await screen.findByText('No matching entries.')).toBeInTheDocument();
  });

  it('exports only the filtered and capped rows, not the full unfiltered set', async () => {
    const user = userEvent.setup();
    const sensitiveRows = Array.from({ length: 250 }, (_, i) => ({
      ts: 1_000_000 + i,
      tool: 'Read',
      target: `/sensitive/${i}`,
      classification: 'sensitive_file',
      sessionId: `s-${i}`,
    }));
    const destructiveRow = {
      ts: 1,
      tool: 'Bash',
      target: 'rm -rf /tmp/x',
      classification: 'destructive_command',
      sessionId: 'x1',
    };
    renderAudit([destructiveRow, ...sensitiveRows]);
    await waitFor(() => expect(screen.getByText('/sensitive/0')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /sensitive files/i }));
    await waitFor(() => expect(screen.queryByText('rm -rf /tmp/x')).toBeNull());

    let capturedBlob: Blob | null = null;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:test/export';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      await user.click(screen.getByRole('button', { name: /export jsonl/i }));
      expect(capturedBlob).not.toBeNull();
      const text = await capturedBlob!.text();
      const lines = text.split('\n').filter(Boolean);
      // Capped at 200, not the full 250 matching rows.
      expect(lines).toHaveLength(200);
      // Filtered out — destructive_command doesn't match the active "Sensitive files" filter.
      expect(text).not.toMatch(/rm -rf \/tmp\/x/);
      expect(text).toMatch(/\/sensitive\/0"/);
      expect(text).toMatch(/\/sensitive\/199"/);
      // Beyond the 200-row cap.
      expect(text).not.toMatch(/\/sensitive\/200"/);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
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
        {
          ts: 1,
          tool: 'Read',
          target: '/etc/hosts',
          classification: 'sensitive_file',
          sessionId: null,
        },
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

  // Firefox silently no-ops .click() on an anchor that's not in
  // the DOM. Audit export must append the anchor to document.body before
  // clicking and remove it after, even when click() throws.
  it('appends the anchor to document.body before clicking and removes after', () => {
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
        {
          ts: 1,
          tool: 'Read',
          target: '/etc/hosts',
          classification: 'sensitive_file',
          sessionId: null,
        },
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
          {
            ts: 1,
            tool: 'Read',
            target: '/etc/hosts',
            classification: 'sensitive_file',
            sessionId: null,
          },
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
