import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AlertBanner } from './AlertBanner';
import { useLiveAlerts } from '../hooks/useLiveAlerts';
import type { AlertEvent } from '../store/liveStore';

const COLLAPSE_THRESHOLD = 5;

type Severity = AlertEvent['severity'];

const SEVERITY_ACCENT: Record<Severity, string> = {
  info: 'text-ink-muted',
  warning: 'text-accent-amber',
  critical: 'text-accent-red',
};

const SEVERITY_BORDER: Record<Severity, string> = {
  info: 'border-bg-line',
  warning: 'border-accent-amber/50',
  critical: 'border-accent-red/60',
};

/**
 * Stack of currently-firing, non-dismissed alert banners. When the stack has
 * 5 or more banners we collapse them behind a header summary to avoid pushing
 * the dashboard content off-screen — clicking the header expands the list.
 */
export function AlertBannerStack(): JSX.Element | null {
  const { alerts, maxSeverity, count, dismiss } = useLiveAlerts();
  const [expanded, setExpanded] = useState(false);

  // F-015: when count drops back below the collapse threshold the expanded
  // path renders without a collapse button (because count < threshold), so
  // a stuck-expanded user could never recollapse without reloading. Reset
  // expanded so the next time the threshold is crossed it starts collapsed.
  useEffect(() => {
    if (count < COLLAPSE_THRESHOLD) setExpanded(false);
  }, [count]);

  if (count === 0) return null;

  const collapsed = count >= COLLAPSE_THRESHOLD && !expanded;
  const headerSeverity: Severity = maxSeverity ?? 'info';

  if (collapsed) {
    return (
      <div className="bg-bg-panel border-b" data-collapsed-stack="true">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded="false"
          aria-label={`${count} alerts firing — expand`}
          className={
            `w-full flex items-center gap-2 px-3 py-2 text-xs text-left ` +
            `border-b ${SEVERITY_BORDER[headerSeverity]} ` +
            `transition-colors duration-150 ` +
            `focus:outline-none focus:ring-2 focus:ring-accent-cyan/50`
          }
        >
          <ChevronRight size={14} aria-hidden="true" focusable="false" />
          <span className={`font-semibold ${SEVERITY_ACCENT[headerSeverity]}`}>
            ● {count} alerts firing
          </span>
          <span className="text-ink-muted">— click to expand</span>
        </button>
      </div>
    );
  }

  return (
    <div data-stack="true">
      {count >= COLLAPSE_THRESHOLD && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded="true"
          aria-label={`${count} alerts firing — collapse`}
          className={
            `w-full flex items-center gap-2 px-3 py-2 text-xs text-left bg-bg-panel ` +
            `border-b ${SEVERITY_BORDER[headerSeverity]} ` +
            `transition-colors duration-150 ` +
            `focus:outline-none focus:ring-2 focus:ring-accent-cyan/50`
          }
        >
          <ChevronDown size={14} aria-hidden="true" focusable="false" />
          <span className={`font-semibold ${SEVERITY_ACCENT[headerSeverity]}`}>
            ● {count} alerts firing
          </span>
          <span className="text-ink-muted">— click to collapse</span>
        </button>
      )}
      {alerts.map((a) => (
        <AlertBanner key={a.id} alert={a} onDismiss={dismiss} />
      ))}
    </div>
  );
}
