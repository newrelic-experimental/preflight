import { useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

import { formatDuration } from '../lib/format.js';

// The canonical AgentRow type now lives in api/client.ts (it mirrors a wire
// response, not a component-local shape) — re-exported here so none of this
// component's existing import sites need to change.
import type { AgentRow } from '../api/client.js';
export type { AgentRow } from '../api/client.js';

export interface AgentTableProps {
  readonly agents: ReadonlyArray<AgentRow>;
}

type SortKey = 'label' | 'model' | 'state' | 'tokens' | 'toolCalls' | 'durationMs';
type SortDir = 'asc' | 'desc';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncateAgentId(id: string, maxLen = 16): string {
  if (id.length <= maxLen) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

interface SortIconProps {
  readonly column: SortKey;
  readonly sortKey: SortKey;
  readonly sortDir: SortDir;
}

function SortIcon({ column, sortKey, sortDir }: SortIconProps): JSX.Element {
  if (column !== sortKey) {
    return <ArrowUpDown className="w-3 h-3 opacity-30" aria-hidden="true" />;
  }
  return sortDir === 'asc' ? (
    <ArrowUp className="w-3 h-3 text-accent-amber" aria-hidden="true" />
  ) : (
    <ArrowDown className="w-3 h-3 text-accent-amber" aria-hidden="true" />
  );
}

interface ThProps {
  readonly column: SortKey;
  readonly label: string;
  readonly sortKey: SortKey;
  readonly sortDir: SortDir;
  readonly onSort: (col: SortKey) => void;
  readonly className?: string;
}

function Th({ column, label, sortKey, sortDir, onSort, className = '' }: ThProps): JSX.Element {
  const isActive = column === sortKey;
  const ariaSort: 'ascending' | 'descending' | 'none' = isActive
    ? sortDir === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`px-3 py-2 text-left text-[10px] uppercase tracking-wider text-ink-muted font-semibold whitespace-nowrap select-none ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 cursor-pointer hover:text-ink-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded-sm"
      >
        {label}
        <SortIcon column={column} sortKey={sortKey} sortDir={sortDir} />
      </button>
    </th>
  );
}

export function AgentTable({ agents }: AgentTableProps): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [copied, setCopied] = useState<string | null>(null);

  function handleSort(col: SortKey): void {
    if (col === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      setSortDir('desc');
    }
  }

  async function handleCopyAgentId(id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard API not available — silently skip
    }
  }

  const sorted = [...agents].sort((a, b) => {
    const aVal = a[sortKey] ?? -Infinity;
    const bVal = b[sortKey] ?? -Infinity;
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    const aNum = aVal as number;
    const bNum = bVal as number;
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum;
  });

  if (agents.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-ink-muted">
        No agent data recorded for this run.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full text-xs" aria-label="Agent activity">
        <thead className="bg-surface-5 border-b border-border-subtle">
          <tr>
            <Th
              column="label"
              label="Agent"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
            <Th
              column="model"
              label="Model"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
            <Th
              column="state"
              label="State"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
            <Th
              column="tokens"
              label="Tokens"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="text-right"
            />
            <Th
              column="toolCalls"
              label="Tool Calls"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="text-right"
            />
            <Th
              column="durationMs"
              label="Duration"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              className="text-right"
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {sorted.map((agent) => (
            <tr key={agent.agentId} className="hover:bg-surface-5 transition-colors">
              {/* Agent label + copyable agent ID + phase subtitle */}
              <td className="px-3 py-2 min-w-0">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <button
                    type="button"
                    title={agent.agentId}
                    aria-label={`Copy agent ID ${agent.agentId}`}
                    onClick={() => void handleCopyAgentId(agent.agentId)}
                    className="text-left text-ink-base font-medium truncate hover:text-accent-cyan transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 rounded"
                  >
                    {copied === agent.agentId ? (
                      <span className="text-accent-green">Copied!</span>
                    ) : (
                      agent.label || truncateAgentId(agent.agentId)
                    )}
                  </button>
                  {agent.phaseTitle && (
                    <span className="text-[10px] text-ink-muted truncate">
                      {agent.phaseTitle}
                      {agent.attempt > 1 ? ` · attempt ${agent.attempt}` : ''}
                    </span>
                  )}
                </div>
              </td>

              {/* Model chip */}
              <td className="px-3 py-2">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-surface-5 text-ink-subtle font-mono">
                  {agent.model || '—'}
                </span>
              </td>

              {/* State */}
              <td className="px-3 py-2">
                <span className="text-ink-subtle">{agent.state || '—'}</span>
              </td>

              {/* Aggregate tokens */}
              <td className="px-3 py-2 text-right tabular-nums text-ink-base font-medium">
                {agent.tokens > 0 ? (
                  fmtTokens(agent.tokens)
                ) : (
                  <span className="text-ink-muted opacity-40">—</span>
                )}
              </td>

              {/* Tool calls */}
              <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                {agent.toolCalls > 0 ? (
                  agent.toolCalls.toLocaleString()
                ) : (
                  <span className="text-ink-muted opacity-40">—</span>
                )}
              </td>

              {/* Duration */}
              <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                {agent.durationMs != null ? (
                  formatDuration(agent.durationMs)
                ) : (
                  <span className="text-ink-muted opacity-40">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
