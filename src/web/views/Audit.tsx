import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAuditLog, qk } from '../api/client';
import { GeoBanner } from '../components/GeoBanner';

interface AuditEntry {
  readonly ts: number;
  readonly tool: string;
  readonly target: string;
  readonly classification: string;
  readonly sessionId?: string;
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sensitive_file', label: 'Sensitive files' },
  { key: 'destructive_command', label: 'Destructive' },
  { key: 'external_network', label: 'External network' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

export function downloadJsonl(rows: AuditEntry[]): void {
  const text = rows.map((r) => JSON.stringify(r)).join('\n');
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.rel = 'noopener';
  // F-018: Firefox silently no-ops .click() on an anchor that's not in
  // the DOM. Append before clicking, then remove. Chromium/Safari work
  // either way; the append is harmless there.
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    document.body.removeChild(a);
    // Revoke synchronously: a.click() returns once the browser has
    // queued the navigation/save, so the blob URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}

export function Audit(): JSX.Element {
  const [filter, setFilter] = useState<FilterKey>('all');
  const { data, isLoading, error } = useQuery<AuditEntry[]>({
    queryKey: qk.audit,
    queryFn: () => fetchAuditLog() as Promise<AuditEntry[]>,
  });

  const rows = data ?? [];
  const visible = filter === 'all' ? rows : rows.filter((r) => r.classification === filter);
  // F-029: Cap rendered rows so the Audit view stays responsive on large
  // logs. Server-side pagination is the proper fix; this guard prevents
  // the table from freezing the page in the meantime.
  const VISIBLE_LIMIT = 200;
  const visibleSlice = visible.slice(0, VISIBLE_LIMIT);

  return (
    <section>
      <GeoBanner theme="audit" />
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold gradient-text">Audit</h1>
        <button
          type="button"
          onClick={() => downloadJsonl(rows)}
          className="text-xs px-2 py-1 bg-surface-5 border border-border-medium rounded-lg hover:border-accent-green hover:glow-green transition-all duration-150"
        >
          Export JSONL
        </button>
      </header>

      <div className="flex gap-2 mb-3 flex-wrap">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={
              'text-xs px-2 py-1 rounded border ' +
              (filter === key
                ? 'bg-accent-green/8 border-accent-green text-ink-base'
                : 'bg-surface-3 border-surface-8 text-ink-subtle hover:border-border-strong')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading && <div className="text-ink-muted text-xs">Loading…</div>}
      {error && <div className="text-accent-red text-xs">Error loading audit log.</div>}

      {!isLoading && !error && visible.length > VISIBLE_LIMIT && (
        <div className="text-[11px] text-ink-muted mb-2">
          Showing first {VISIBLE_LIMIT} of {visible.length} entries.
        </div>
      )}

      {!isLoading && !error && (
        <div className="glass-card">
          <table className="w-full text-xs">
            <thead className="text-ink-muted bg-surface-3">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Tool</th>
                <th className="text-left p-2">Target</th>
                <th className="text-left p-2">Classification</th>
                <th className="text-left p-2">Session</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-3 text-ink-muted text-center">
                    No matching entries.
                  </td>
                </tr>
              )}
              {visibleSlice.map((r) => (
                <tr key={`${r.ts}-${r.tool}-${r.target}`} className="border-t border-border-subtle">
                  <td className="p-2 tabular-nums">
                    {new Date(r.ts).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="p-2">{r.tool}</td>
                  <td className="p-2 font-mono text-[11px]">{r.target}</td>
                  <td className="p-2">
                    <span className="px-1.5 py-0.5 bg-surface-8 rounded text-[10px]">
                      {r.classification}
                    </span>
                  </td>
                  <td className="p-2 text-ink-subtle">{r.sessionId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
