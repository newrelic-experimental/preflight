import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type {
  DecisionTreeResponse,
  TurnCostsResponse,
  ContextResponse,
  ContextCompositionResponse,
  ContextEfficiencyResponse,
} from '../api/client';
import { Card, Eyebrow, Pill, type PillTone } from './ui';
import { formatTokensCompact } from '../lib/format.js';
import { ContextTimeline } from './ContextBar';

export interface SessionDetailDialogProps {
  readonly decisionTree: DecisionTreeResponse | undefined;
  readonly turnCosts: TurnCostsResponse | undefined;
  readonly contextHistory?: ContextResponse['history'];
  readonly contextWindow?: number;
  readonly contextComposition?: ContextCompositionResponse;
  readonly contextEfficiency?: ContextEfficiencyResponse;
  readonly onClose: () => void;
}

const OUTCOME_TONE: Record<'unknown' | 'success' | 'failure', PillTone> = {
  success: 'success',
  failure: 'danger',
  unknown: 'neutral',
};

// Same drawer/backdrop/focus-trap pattern as WorkflowRunDetail — kept in
// lockstep with that component so the two dialogs behave identically.
export function SessionDetailDialog({
  decisionTree,
  turnCosts,
  contextHistory,
  contextWindow,
  contextComposition,
  contextEfficiency,
  onClose,
}: SessionDetailDialogProps): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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

  const hasDecisionData = decisionTree != null && decisionTree.totalBranches > 0;
  const hasTurnData = turnCosts?.turns != null && turnCosts.turns.length > 0;
  const hasContextTimeline = (contextHistory?.length ?? 0) >= 2;

  // Portaled to document.body: LiveSessionPane's `.animate-card-enter`
  // ancestor keeps a non-`none` `transform` after its entrance animation
  // settles (animation-fill-mode: both), which makes it a containing block
  // for `position: fixed` descendants — without the portal this drawer
  // renders clipped to that 320px card instead of the viewport.
  return createPortal(
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
        aria-label="Session decision-tree and turn-cost detail"
        className="fixed right-0 top-0 bottom-0 z-50 w-[640px] max-w-full flex flex-col bg-bg-panel border-l border-border-medium shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border-subtle shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-ink-base">Session Detail</h2>
            <p className="mt-1 text-[10px] text-ink-muted">
              Live, current-process-only — reflects this dashboard process&rsquo;s own current
              session.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close session detail"
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-ink-base hover:bg-surface-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <section aria-label="Decision tree">
            <Eyebrow className="mb-3">Decision Tree</Eyebrow>
            <Card tone="static" padding="sm">
              {!hasDecisionData ? (
                <div className="py-2 text-center text-xs text-ink-muted">
                  No decision-tree data yet.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat
                      label="Longest failure streak"
                      value={String(decisionTree.longestFailureStreak)}
                    />
                    <Stat
                      label="Success rate"
                      value={
                        decisionTree.successRate !== null
                          ? `${Math.round(decisionTree.successRate * 100)}%`
                          : '—'
                      }
                    />
                    <Stat label="Total branches" value={String(decisionTree.totalBranches)} />
                  </div>
                  {decisionTree.failurePoints.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-border-subtle space-y-2">
                      {decisionTree.failurePoints.map((branch, i) => (
                        <div
                          key={`${branch.turnNumber}-${i}`}
                          className="flex items-start justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-ink-muted">Turn {branch.turnNumber}</span>
                              {branch.toolName && (
                                <code className="text-[10px] bg-surface-5 px-1 rounded">
                                  {branch.toolName}
                                </code>
                              )}
                              <Pill tone={OUTCOME_TONE[branch.outcome]} size="sm">
                                {branch.outcome}
                              </Pill>
                            </div>
                            <p className="mt-0.5 text-ink-subtle break-words">{branch.reasoning}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {decisionTree.note && (
                    <p className="mt-3 pt-3 border-t border-border-subtle text-[10px] text-ink-muted">
                      {decisionTree.note}
                    </p>
                  )}
                </>
              )}
            </Card>
          </section>

          <section aria-label="Turn costs">
            <Eyebrow className="mb-3">Turn Costs</Eyebrow>
            <Card tone="static" padding="sm">
              {!hasTurnData ? (
                <div className="py-2 text-center text-xs text-ink-muted">
                  No turn-cost data yet.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 mb-3 pb-3 border-b border-border-subtle">
                    <Stat
                      label="Total attributed cost"
                      value={`$${turnCosts.totalAttributedCost.toFixed(2)}`}
                    />
                    <Stat
                      label="Attribution rate"
                      value={`${Math.round(turnCosts.attributionRate * 100)}%`}
                    />
                  </div>
                  <div className="space-y-2">
                    {turnCosts.turns.map((t) => (
                      <div
                        key={t.turnId}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="text-ink-base">{t.toolNames.join(', ')}</div>
                          <div className="text-[10px] text-ink-muted font-mono">
                            {t.model} · {formatTokensCompact(t.inputTokens)} in /{' '}
                            {formatTokensCompact(t.outputTokens)} out /{' '}
                            {formatTokensCompact(t.cacheReadTokens)} cache
                          </div>
                        </div>
                        <span className="shrink-0 tabular-nums text-ink-base">
                          ${t.estimatedCostUsd.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </section>

          <section aria-label="Context timeline">
            <Eyebrow className="mb-3">Context Timeline</Eyebrow>
            <Card tone="static" padding="sm">
              {hasContextTimeline ? (
                <ContextTimeline
                  history={contextHistory ?? []}
                  contextWindow={contextWindow ?? 0}
                />
              ) : (
                <div className="py-2 text-center text-xs text-ink-muted">
                  No context timeline data yet.
                </div>
              )}
            </Card>
          </section>

          <section aria-label="Context composition and efficiency">
            <Eyebrow className="mb-3">Context Composition &amp; Efficiency</Eyebrow>
            <Card tone="static" padding="sm">
              {!contextComposition && !contextEfficiency ? (
                <div className="py-2 text-center text-xs text-ink-muted">
                  No composition/efficiency data yet.
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  {contextComposition && (
                    <div className="text-ink-muted">
                      Dominant this turn:{' '}
                      <span className="text-ink-base">
                        {
                          Object.entries(contextComposition.currentBreakdown).sort(
                            (a, b) => b[1] - a[1],
                          )[0]?.[0]
                        }
                      </span>
                    </div>
                  )}
                  {contextEfficiency && contextEfficiency.repeatedReadRatio !== null && (
                    <div className="text-ink-muted">
                      Repeated reads:{' '}
                      <span className="text-ink-base">
                        {Math.round(contextEfficiency.repeatedReadRatio * 100)}%
                      </span>
                      {contextEfficiency.topRepeatedFiles[0] && (
                        <>
                          {' '}
                          — top:{' '}
                          <code className="bg-surface-5 px-1 rounded">
                            {contextEfficiency.topRepeatedFiles[0].file}
                          </code>{' '}
                          ({contextEfficiency.topRepeatedFiles[0].readCount}x)
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </section>
        </div>
      </div>
    </>,
    document.body,
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</div>
      <div className="text-sm font-bold tabular-nums text-ink-base mt-0.5">{value}</div>
    </div>
  );
}
