import type { KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { AlertEvent } from '../store/liveStore';

type Severity = AlertEvent['severity'];

const SEVERITY_BG: Record<Severity, string> = {
  info: 'bg-bg-panel border-bg-line',
  warning: 'bg-bg-panel border-accent-amber/50',
  critical: 'bg-bg-panel border-accent-red/60',
};

const SEVERITY_TEXT: Record<Severity, string> = {
  info: 'text-ink-muted',
  warning: 'text-accent-amber',
  critical: 'text-accent-red',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'INFO',
  warning: 'WARN',
  critical: 'CRIT',
};

export interface AlertBannerProps {
  readonly alert: AlertEvent;
  readonly onDismiss: (id: string) => void;
}

/**
 * Severity → ARIA role mapping. `role="alert"` is assertive — it forces
 * screen readers to interrupt the current speech queue. We use it only for
 * critical alerts; warning/info use `role="status"` (polite) so they don't
 * stomp on user activity.
 */
function ariaRole(severity: Severity): 'alert' | 'status' {
  return severity === 'critical' ? 'alert' : 'status';
}

export function AlertBanner({ alert, onDismiss }: AlertBannerProps): JSX.Element {
  // ESC dismisses no matter where focus lives within the banner — attaching
  // the handler to the outer container (rather than just the X button) makes
  // the gesture work even when the title/description is keyboard-focused.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss(alert.id);
    }
  };

  return (
    <div
      role={ariaRole(alert.severity)}
      aria-live={alert.severity === 'critical' ? 'assertive' : 'polite'}
      data-alert-id={alert.id}
      data-severity={alert.severity}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-3 px-3 py-2 border-b text-xs ${SEVERITY_BG[alert.severity]}`}
    >
      <span
        aria-hidden="true"
        className={`shrink-0 font-semibold tracking-wider ${SEVERITY_TEXT[alert.severity]}`}
      >
        ● {SEVERITY_LABEL[alert.severity]}
      </span>
      <span className="font-medium text-ink-base shrink-0">{alert.title}</span>
      <span className="text-ink-muted truncate">{alert.description}</span>
      <span className="ml-auto shrink-0 text-ink-subtle tabular-nums whitespace-nowrap">
        {formatValue(alert.value)} / {formatValue(alert.threshold)}
      </span>
      <button
        type="button"
        aria-label="Dismiss alert"
        onClick={() => onDismiss(alert.id)}
        className="shrink-0 ml-1 p-1 rounded text-ink-subtle hover:text-ink-base focus:outline-none focus:ring-2 focus:ring-accent-cyan/50"
      >
        <X size={14} aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}

function formatValue(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
