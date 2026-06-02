import { Home, Clock, TrendingUp, ShieldCheck } from 'lucide-react';
import { StatusIndicator } from './StatusIndicator';
import { useLiveAlerts } from '../hooks/useLiveAlerts';
import type { AlertEvent } from '../store/liveStore';

const NAV = [
  { path: '/', label: 'Today', Icon: Home },
  { path: '/sessions', label: 'Sessions', Icon: Clock },
  { path: '/history', label: 'History', Icon: TrendingUp },
  { path: '/audit', label: 'Audit', Icon: ShieldCheck },
] as const;

const BADGE_TONE: Record<AlertEvent['severity'], string> = {
  info: 'bg-bg-line text-ink-base',
  warning: 'bg-accent-amber/20 text-accent-amber',
  critical: 'bg-accent-red/20 text-accent-red',
};

export interface SidebarProps {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
  readonly connected: boolean;
}

export function Sidebar({ currentPath, onNavigate, connected }: SidebarProps): JSX.Element {
  const { count: alertCount, maxSeverity } = useLiveAlerts();

  return (
    <aside className="w-44 bg-bg-panel border-r border-bg-line p-3 flex flex-col">
      <div className="text-accent-cyan font-semibold text-sm tracking-wide">NR-AI</div>
      <div className="text-ink-muted text-[10px] uppercase tracking-wider mt-0.5">
        local · single-user
      </div>

      <nav aria-label="Primary" className="mt-4 flex flex-col gap-0.5">
        {NAV.map(({ path, label, Icon }) => {
          const active = currentPath === path;
          const showBadge = path === '/' && alertCount > 0;
          return (
            <button
              key={path}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(path)}
              className={
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left ' +
                (active
                  ? 'bg-bg-line text-ink-base font-medium'
                  : 'text-ink-subtle hover:text-ink-base')
              }
            >
              <Icon size={14} aria-hidden="true" focusable="false" />
              <span>{label}</span>
              {showBadge && (
                <span
                  data-testid="alert-badge"
                  data-severity={maxSeverity ?? 'info'}
                  aria-label={`${alertCount} firing ${alertCount === 1 ? 'alert' : 'alerts'}`}
                  className={
                    `ml-auto px-1.5 rounded text-[10px] font-semibold tabular-nums ` +
                    BADGE_TONE[maxSeverity ?? 'info']
                  }
                >
                  {alertCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto pt-3 border-t border-bg-line">
        <div className="text-ink-muted text-[10px] uppercase tracking-wider mb-1">live</div>
        {connected ? (
          <StatusIndicator tone="good" label="connected" />
        ) : (
          <StatusIndicator tone="warn" label="reconnecting" />
        )}
      </div>
    </aside>
  );
}
