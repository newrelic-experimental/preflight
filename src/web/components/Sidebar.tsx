import {
  Home,
  Clock,
  TrendingUp,
  ShieldCheck,
  GitBranch,
  Sun,
  Moon,
  Settings2,
  Bell,
} from 'lucide-react';

import { useLiveAlerts } from '../hooks/useLiveAlerts';
import type { AlertEvent } from '../store/liveStore';
import type { Theme } from '../hooks/useTheme';
import { Button, Pill } from './ui';
import type { PillTone } from './ui';

const NAV_OBSERVE = [
  { path: '/', label: 'Today', Icon: Home },
  { path: '/sessions', label: 'Sessions', Icon: Clock },
] as const;

const NAV_ANALYZE = [
  { path: '/history', label: 'History', Icon: TrendingUp },
  { path: '/git', label: 'Git', Icon: GitBranch },
  { path: '/audit', label: 'Audit', Icon: ShieldCheck },
] as const;

const NAV_CONFIGURE = [
  { path: '/settings', label: 'Settings', Icon: Settings2 },
  { path: '/alerts', label: 'Alerts', Icon: Bell },
] as const;

const SEVERITY_TONE: Record<AlertEvent['severity'], PillTone> = {
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

export interface SidebarProps {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
  readonly connected: boolean;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}

export function Sidebar({
  currentPath,
  onNavigate,
  connected,
  theme,
  onToggleTheme,
}: SidebarProps): JSX.Element {
  const { count: alertCount, maxSeverity } = useLiveAlerts();

  function renderNavItem({
    path,
    label,
    Icon,
  }: {
    path: string;
    label: string;
    Icon: typeof Home;
  }) {
    const active = currentPath === path;
    const showBadge = path === '/' && alertCount > 0;
    const severity = maxSeverity ?? 'info';
    return (
      <button
        key={path}
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(path)}
        className={
          'flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-left transition-colors duration-150 ' +
          (active
            ? 'border-l-[3px] border-l-accent-green bg-accent-green/8 text-ink-base font-medium pl-2.5'
            : 'border-l-[3px] border-l-transparent text-ink-subtle hover:text-ink-base hover:bg-surface-3')
        }
      >
        <Icon size={14} aria-hidden="true" focusable="false" />
        <span>{label}</span>
        {showBadge && (
          <Pill
            tone={SEVERITY_TONE[severity]}
            size="sm"
            className="ml-auto font-semibold tabular-nums"
            data-testid="alert-badge"
            data-severity={severity}
            aria-label={`${alertCount > 99 ? '99+' : alertCount} firing ${alertCount === 1 ? 'alert' : 'alerts'}`}
          >
            {alertCount > 99 ? '99+' : alertCount}
          </Pill>
        )}
      </button>
    );
  }

  return (
    <aside className="w-52 bg-bg-deep border-r border-border-subtle p-4 flex flex-col">
      {/* Logo + brand */}
      <div className="flex items-center gap-2 mb-1">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          {/* Observatory dome */}
          <path
            d="M5 18 L5 14 Q5 8 12 6 Q19 8 19 14 L19 18"
            fill="none"
            stroke="url(#logoGrad)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          {/* Base */}
          <line
            x1="3"
            y1="18"
            x2="21"
            y2="18"
            stroke="url(#logoGrad)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          {/* Telescope */}
          <line
            x1="12"
            y1="10"
            x2="17"
            y2="4"
            stroke="url(#logoGrad)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* Star */}
          <circle cx="18" cy="3" r="1" fill="#ffd166" />
          <defs>
            <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#9945ff" />
              <stop offset="50%" stopColor="#e94e8a" />
              <stop offset="100%" stopColor="#1ce783" />
            </linearGradient>
          </defs>
        </svg>
        <span className="font-semibold text-sm tracking-tight gradient-text">observatory</span>
      </div>
      <div className="text-ink-muted text-[10px] tracking-wide mb-6">
        local &middot; single-user
      </div>

      {/* OBSERVE section */}
      <div className="text-[10px] font-medium text-ink-muted uppercase tracking-wider mb-2 px-2">
        Observe
      </div>
      <nav aria-label="Observe" className="flex flex-col gap-0.5 mb-4">
        {NAV_OBSERVE.map((item) => renderNavItem(item))}
      </nav>

      {/* ANALYZE section */}
      <div className="text-[10px] font-medium text-ink-muted uppercase tracking-wider mb-2 px-2">
        Analyze
      </div>
      <nav aria-label="Analyze" className="flex flex-col gap-0.5 mb-4">
        {NAV_ANALYZE.map((item) => renderNavItem(item))}
      </nav>

      {/* CONFIGURE section */}
      <div className="text-[10px] font-medium text-ink-muted uppercase tracking-wider mb-2 px-2">
        Configure
      </div>
      <nav aria-label="Configure" className="flex flex-col gap-0.5">
        {NAV_CONFIGURE.map((item) => renderNavItem(item))}
      </nav>

      {/* Footer */}
      <div className="mt-auto pt-3 border-t border-border-subtle">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-md bg-surface-3 transition-colors duration-150">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${connected ? 'bg-accent-green animate-pulse' : 'bg-accent-amber'}`}
            />
            <span className="text-[10px] text-ink-subtle tracking-wide">
              {connected ? 'live' : 'reconnecting'}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="px-1 py-1"
          >
            {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
          </Button>
        </div>
      </div>
    </aside>
  );
}
