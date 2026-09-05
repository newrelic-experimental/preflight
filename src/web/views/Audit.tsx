import { useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchAuditLog, qk, type AuditEntry } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { GeoBanner } from '../components/GeoBanner';
import { Button, Card, Pill } from '../components/ui';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sensitive_file', label: 'Sensitive files' },
  { key: 'destructive_command', label: 'Destructive' },
  { key: 'external_network', label: 'External network' },
  { key: 'file_deletion', label: 'File deletion' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
};

// Labels for the classification Pill, distinct from FILTERS above (which only
// covers the filter chips — 'all' isn't a real classification, and 'other'
// isn't a filter). Every classification toAuditEntry() can produce needs an
// entry here so the Pill never falls back to rendering the raw key.
const CLASSIFICATION_LABELS: Record<string, string> = {
  sensitive_file: 'Sensitive files',
  destructive_command: 'Destructive',
  external_network: 'External network',
  file_deletion: 'File deletion',
  other: 'Other',
};

export function downloadJsonl(rows: AuditEntry[]): void {
  const text = rows.map((r) => JSON.stringify(r)).join('\n');
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.rel = 'noopener';
  // Firefox silently no-ops .click() on an anchor that's not in
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
  const { data, isLoading, error, refetch } = useQuery<AuditEntry[]>({
    queryKey: qk.audit,
    queryFn: () => fetchAuditLog(),
    refetchInterval: 10_000,
  });

  const rows = data ?? [];
  const visible = filter === 'all' ? rows : rows.filter((r) => r.classification === filter);
  // Cap rendered rows so the Audit view stays responsive on large
  // logs. Server-side pagination is the proper fix; this guard prevents
  // the table from freezing the page in the meantime.
  const VISIBLE_LIMIT = 200;
  const visibleSlice = visible.slice(0, VISIBLE_LIMIT);

  return (
    <section>
      <GeoBanner theme="audit" />
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold gradient-text">Audit</h1>
        <Button variant="secondary" size="md" onClick={() => downloadJsonl(visibleSlice)}>
          {/* Discloses the row cap at the point of action rather than only in
              the table footer note below — the export always mirrors
              visibleSlice, so it's silently capped even when the footer note
              is scrolled out of view. */}
          Export JSONL (max {VISIBLE_LIMIT} rows)
        </Button>
      </header>

      <div className="flex gap-2 mb-3 flex-wrap">
        {FILTERS.map(({ key, label }) => (
          <Button
            key={key}
            variant={filter === key ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {isLoading && <EmptyState icon="clock" variant="loading" title="Loading..." />}
      {error && (
        <div className="text-accent-red text-xs flex items-center gap-2">
          <span>Error loading audit log.</span>
          <button
            onClick={() => void refetch()}
            className="text-[10px] text-ink-muted hover:text-ink-base transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && visible.length > VISIBLE_LIMIT && (
        <div className="text-[11px] text-ink-muted mb-2">
          Showing first {VISIBLE_LIMIT} of {visible.length} entries.
        </div>
      )}

      {!isLoading && !error && (
        <Card padding="sm" tone="static" className="overflow-hidden">
          <table className="w-full text-xs">
            <thead className="text-ink-muted bg-surface-3">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Tool</th>
                <th className="text-left p-2">Target</th>
                <th className="text-left p-2">Classification</th>
                <th className="text-left p-2">Agent</th>
                <th className="text-left p-2">Session</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-ink-muted text-center">
                    No matching entries.
                  </td>
                </tr>
              )}
              {visibleSlice.map((r) => (
                <tr key={r.id} className="border-t border-border-subtle">
                  <td className="p-2 tabular-nums">
                    {new Date(r.ts).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="p-2">{r.tool}</td>
                  <td className="p-2 font-mono text-[11px] break-all" title={r.target}>
                    {r.target}
                  </td>
                  <td className="p-2">
                    <Pill
                      tone={r.severity ? (SEVERITY_TONE[r.severity] ?? 'neutral') : 'neutral'}
                      size="sm"
                    >
                      {CLASSIFICATION_LABELS[r.classification] ?? r.classification}
                    </Pill>
                  </td>
                  <td className="p-2 text-ink-subtle" title={r.agentId}>
                    {r.agentType ?? r.agentId ?? '—'}
                  </td>
                  <td className="p-2 text-ink-subtle">
                    {r.sessionId ? (
                      <Link
                        href={`/sessions?session=${encodeURIComponent(r.sessionId)}`}
                        className="text-accent-cyan hover:underline transition-colors duration-150"
                      >
                        {r.sessionId}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
