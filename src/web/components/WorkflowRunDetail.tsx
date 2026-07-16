import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react';
import {
  fetchWorkflowDetail,
  qk,
  type WorkflowRunInfo,
  type WorkflowRunDetailResponse,
} from '../api/client.js';
import { AgentTable } from './AgentTable.js';
import type { AgentRow } from './AgentTable.js';
import { AgentSwimlanes, type AgentSpan } from './AgentSwimlanes.js';
import { Card } from './ui/index.js';
import { Pill } from './ui/index.js';
import { Eyebrow } from './ui/index.js';
import { formatDuration, formatUsd } from '../lib/format.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowRunDetailProps {
  readonly runId: string;
  readonly onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_PILL: Record<
  WorkflowRunInfo['status'],
  { tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info'; label: string }
> = {
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'warning', label: 'Cancelled' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

function StatusIcon({ status }: { readonly status: WorkflowRunInfo['status'] }): JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-accent-green" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-accent-red" aria-hidden="true" />;
    case 'running':
      return <Loader2 className="w-4 h-4 text-accent-cyan animate-spin" aria-hidden="true" />;
    case 'cancelled':
      return <Clock className="w-4 h-4 text-accent-amber" aria-hidden="true" />;
    default:
      return <Clock className="w-4 h-4 text-ink-muted" aria-hidden="true" />;
  }
}

// Map the run-detail agent rows (camelCase DTO) onto AgentSpan for the
// swimlane chart. AgentRow carries no per-agent usd, so usd is null. Rows
// without a startedAt timestamp cannot be positioned on a time axis and are
// dropped here; when nothing is positionable the caller renders no chart.
function toAgentSpans(
  agents: ReadonlyArray<AgentRow>,
  runId: string,
  workflowName: string | null,
): AgentSpan[] {
  const spans: AgentSpan[] = [];
  for (const a of agents) {
    if (a.startedAt == null) continue;
    const durationMs = a.durationMs ?? 0;
    spans.push({
      agentId: a.agentId,
      workflowRunId: runId,
      workflowName,
      label: a.label || a.agentId,
      model: a.model,
      startMs: a.startedAt,
      endMs: a.startedAt + durationMs,
      durationMs,
      turnCount: a.toolCalls,
      totalTokens: a.tokens,
      usd: null,
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowRunDetail({ runId, onClose }: WorkflowRunDetailProps): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ESC key and focus trap
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const { data, isLoading, isError } = useQuery<WorkflowRunDetailResponse>({
    queryKey: qk.workflowDetail(runId),
    queryFn: () => fetchWorkflowDetail(runId),
    refetchInterval: 5_000,
  });

  const run = data?.run;
  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);
  const topology = data?.topology ?? null;

  const pillMeta = run != null ? (STATUS_PILL[run.status] ?? STATUS_PILL.unknown) : null;

  // Failure reason: only the orchestrator's trimmed+redacted top-level reason
  // line, and only for failure states. Never shown for completed/running runs
  // or when the reason is absent/empty.
  const failureReason =
    run != null &&
    (run.status === 'failed' || run.status === 'cancelled') &&
    typeof run.errorReason === 'string' &&
    run.errorReason.trim() !== ''
      ? run.errorReason
      : null;

  // Reconciliation: rollup tokens vs the sum of per-agent aggregate tokens.
  // The rollup is the run's authoritative total_tokens; agents carry only a
  // single aggregate `tokens` field (no input/output split in wf_*.json).
  const agentTokenSum = agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0);
  const rollupTokens = run?.totalTokens ?? null;
  const tokenDelta = rollupTokens != null ? rollupTokens - agentTokenSum : null;

  // Swimlane spans + window for this run's agents. Only agents with a
  // startedAt are positionable; if none are, swimlaneSpans is empty and the
  // chart section is skipped.
  const swimlaneSpans = useMemo<AgentSpan[]>(
    () => (run != null ? toAgentSpans(agents, run.runId, run.workflowName ?? null) : []),
    [agents, run],
  );
  const swimlaneWindow = useMemo<{ startMs: number; endMs: number }>(() => {
    if (swimlaneSpans.length === 0) return { startMs: 0, endMs: 1 };
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    for (const s of swimlaneSpans) {
      if (s.startMs < startMs) startMs = s.startMs;
      if (s.endMs > endMs) endMs = s.endMs;
    }
    // Guard against a zero-width window when every span is instantaneous.
    return { startMs, endMs: endMs > startMs ? endMs : startMs + 1 };
  }, [swimlaneSpans]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Workflow run details: ${run?.workflowName ?? runId}`}
        className="fixed right-0 top-0 bottom-0 z-50 w-[640px] max-w-full flex flex-col bg-bg-panel border-l border-border-medium shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border-subtle shrink-0">
          <div className="flex-1 min-w-0">
            {isLoading && (
              <div className="flex items-center gap-2 text-ink-muted">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span className="text-sm">Loading run details…</span>
              </div>
            )}
            {isError && (
              <span className="text-sm text-accent-red">Failed to load run details.</span>
            )}
            {run != null && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusIcon status={run.status} />
                  <h2 className="text-sm font-semibold text-ink-base truncate">
                    {run.workflowName}
                  </h2>
                  {pillMeta != null && (
                    <Pill tone={pillMeta.tone} size="sm" bordered>
                      {pillMeta.label}
                    </Pill>
                  )}
                  {run.runSource != null && (
                    <Pill tone="neutral" size="sm">
                      {run.runSource}
                    </Pill>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-ink-muted flex-wrap">
                  <span className="font-mono">{runId}</span>
                  {run.startedAt != null && <span>{new Date(run.startedAt).toLocaleString()}</span>}
                  {run.durationMs != null && <span>{formatDuration(run.durationMs)}</span>}
                  {run.defaultModel && <span className="font-mono">{run.defaultModel}</span>}
                </div>
              </>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close run details"
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-ink-base hover:bg-surface-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {run != null && (
            <>
              {/* Failure reason — only for failed/cancelled runs with a
                  non-empty, already trimmed+redacted top-level reason line
                  Rendered above the reconciliation card. */}
              {failureReason != null && (
                <Card tone="static" padding="sm">
                  <Eyebrow className="mb-2">Failure reason</Eyebrow>
                  <div className="flex items-start gap-2">
                    <XCircle
                      className="w-4 h-4 text-accent-red shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <p className="text-xs text-accent-red font-mono break-words">{failureReason}</p>
                  </div>
                </Card>
              )}

              {/* Reconciliation card */}
              {(run.totalTokens != null || rollupTokens != null) && (
                <Card tone="static" padding="sm">
                  <Eyebrow className="mb-2">Token Reconciliation</Eyebrow>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Rollup
                      </div>
                      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">
                        {rollupTokens != null ? rollupTokens.toLocaleString() : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Agent Sum
                      </div>
                      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">
                        {agentTokenSum.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Delta
                      </div>
                      <div
                        className={`text-sm font-bold tabular-nums mt-0.5 ${
                          tokenDelta === null
                            ? 'text-ink-muted'
                            : tokenDelta === 0
                              ? 'text-accent-green'
                              : 'text-accent-amber'
                        }`}
                      >
                        {tokenDelta === null
                          ? '—'
                          : tokenDelta === 0
                            ? '0'
                            : `${tokenDelta > 0 ? '+' : ''}${tokenDelta.toLocaleString()}`}
                      </div>
                    </div>
                  </div>
                  {run.totalUsd != null && (
                    <div className="mt-2 pt-2 border-t border-border-subtle flex items-center justify-between">
                      <span className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Total Cost
                      </span>
                      <span className="text-xs font-bold text-accent-amber tabular-nums">
                        {formatUsd(run.totalUsd)}
                      </span>
                    </div>
                  )}
                </Card>
              )}

              {/* Declared topology summary (counts only — no per-phase timeline
                  exists in the rollup). Phase progression is visible per-agent
                  in the agent table's phase subtitle. */}
              {topology != null && (
                <Card tone="static" padding="sm">
                  <Eyebrow className="mb-2">Topology</Eyebrow>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Declared Phases
                      </div>
                      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">
                        {topology.declaredPhases != null ? topology.declaredPhases : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Observed Phases
                      </div>
                      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">
                        {run.observedPhases != null ? run.observedPhases : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-muted uppercase tracking-wider">
                        Declared Agents
                      </div>
                      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">
                        {topology.declaredAgents != null ? topology.declaredAgents : '—'}
                      </div>
                    </div>
                  </div>
                  {topology.declaredParallelWidths != null &&
                    topology.declaredParallelWidths.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border-subtle flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-ink-muted uppercase tracking-wider">
                          Parallel Widths
                        </span>
                        {topology.declaredParallelWidths.map((w, i) => (
                          <span
                            key={`${w}-${i}`}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-surface-5 text-ink-subtle font-mono"
                          >
                            {w}
                          </span>
                        ))}
                      </div>
                    )}
                </Card>
              )}

              {/* Fan-out timeline. Only rendered when at least one agent has a
                  startedAt timestamp to position it on the axis; otherwise we
                  fall through to the table alone. */}
              {swimlaneSpans.length > 0 && (
                <section aria-label="Agent fan-out timeline">
                  <Eyebrow className="mb-3">Fan-out timeline</Eyebrow>
                  <Card tone="static" padding="sm">
                    <AgentSwimlanes agents={swimlaneSpans} window={swimlaneWindow} />
                  </Card>
                </section>
              )}

              {/* Agent table */}
              {agents.length > 0 ? (
                <section aria-label="Agent activity">
                  <Eyebrow className="mb-3">Agents ({agents.length})</Eyebrow>
                  <AgentTable agents={agents} />
                </section>
              ) : (
                <div className="py-6 text-center text-xs text-ink-muted">
                  No agent data recorded for this run.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
