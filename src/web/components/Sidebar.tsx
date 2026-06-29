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
  ExternalLink,
} from 'lucide-react';

import { useLiveAlerts } from '../hooks/useLiveAlerts';
import { useVersionInfo } from '../hooks/useVersionInfo';
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
  const versionInfo = useVersionInfo();

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
        <svg width="22" height="22" viewBox="0 0 128 128" aria-hidden="true">
          <rect width="128" height="128" rx="24" fill="url(#preflightGrad)" />
          <path
            d="M21.1599 74.0495L29.1148 66.0946L45.3429 68.9583L56.7981 57.5032L21.1599 42.2297L30.7058 32.6838L73.9808 40.3205L87.9815 26.3198C89.7316 24.5697 91.8529 23.6947 94.3454 23.6947C96.838 23.6947 98.9593 24.5697 100.709 26.3198C102.459 28.0699 103.335 30.1912 103.335 32.6838C103.335 35.1763 102.459 37.2976 100.709 39.0477L86.7087 53.0484L94.3454 96.3234L84.7995 105.869L69.526 70.2311L58.0709 81.6863L60.9346 97.9144L52.9797 105.869L41.8428 85.1864L21.1599 74.0495Z"
            fill="#080F11"
          />
          <defs>
            <linearGradient
              id="preflightGrad"
              x1="64"
              y1="0"
              x2="64"
              y2="128"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0.12" stopColor="#D2FA37" />
              <stop offset="0.88" stopColor="#1CE783" />
            </linearGradient>
          </defs>
        </svg>
        <span className="font-semibold text-sm tracking-tight brand-text">Preflight</span>
        <span className="text-ink-muted text-[10px] leading-none select-none">|</span>
        <span className="text-ink-muted text-[9px] leading-none">by</span>
        <svg
          width="46"
          height="9"
          viewBox="0 0 819.12 159.36"
          aria-label="New Relic"
          fill="currentColor"
          className="text-ink-subtle flex-shrink-0"
        >
          <polygon points="68.85 .18 8.05 35.28 34.54 50.57 68.85 30.76 111.21 55.22 111.21 104.14 76.9 123.95 76.9 154.53 137.7 119.43 137.7 39.93 68.85 .18" />
          <polygon points="42.36 94.97 42.36 143.89 68.85 159.18 68.85 79.68 0 39.93 0 70.51 42.36 94.97" />
          <path d="M232.21,39.81c-14.82,0-21.84,9.36-21.84,9.36h-.78l-1.56-7.8h-17.94v79.57h19.5v-46.03c0-10.14,7.02-17.16,17.16-17.16s17.16,7.02,17.16,17.16v46.03h19.5v-47.59c0-20.28-13.26-33.55-31.21-33.55Z" />
          <polygon points="442.54 93.64 441.42 93.64 428.15 41.38 408.31 41.38 395.05 93.64 393.93 93.64 380.67 41.38 360.39 41.38 380.67 120.95 404.41 120.95 417.67 69.46 418.79 69.46 432.06 120.95 455.8 120.95 476.08 41.38 455.8 41.38 442.54 93.64" />
          <path d="M535.8,48.4h-.78l-1.56-7.02h-16.38v79.57h19.5v-46.02c0-10.14,4.68-14.82,14.82-14.82h10.04v-18.72h-11.6c-9.36,0-14.04,7.02-14.04,7.02Z" />
          <path d="M604.56,39.82c-23.4,0-40.56,17.16-40.56,41.34s16.19,41.34,40.56,41.34c19.73,0,31.61-11.61,36.56-20.15l-17.9-6.38c-1.78,3.24-8.91,9.47-18.66,9.47-11.37,0-19.5-7.12-21.06-18.04h59.29s.78-3.12.78-7.8c0-22.62-17.16-39.78-39-39.78ZM583.5,74.14c2.34-10.14,9.36-17.94,21.06-17.94,10.92,0,17.94,7.8,19.5,17.94h-40.56Z" />
          <path d="M316.44,39.82c-23.4,0-40.56,17.16-40.56,41.34s16.19,41.34,40.56,41.34c19.73,0,31.61-11.61,36.56-20.15l-17.9-6.38c-1.78,3.24-8.91,9.47-18.66,9.47-11.37,0-19.5-7.12-21.06-18.04h59.29s.78-3.12.78-7.8c0-22.62-17.16-39.78-39-39.78ZM295.38,74.14c2.34-10.14,9.36-17.94,21.06-17.94,10.92,0,17.94,7.8,19.5,17.94h-40.56Z" />
          <rect x="692.24" y="9.96" width="19.5" height="19.5" />
          <path d="M765.56,104.56c-11.7,0-21.06-9.36-21.06-23.4s9.36-23.4,21.06-23.4,16.38,7.8,17.94,12.48l17.66-6.28c-4.27-11.11-14.77-24.14-35.6-24.14-23.4,0-40.56,17.16-40.56,41.34s17.16,41.34,40.56,41.34c21,0,31.5-13.25,35.71-24.88l-17.77-6.32c-1.56,5.46-6.24,13.26-17.94,13.26Z" />
          <polygon points="645.72 27.3 656.79 27.3 656.79 120.95 676.3 120.95 676.3 9.96 645.72 9.96 645.72 27.3" />
          <rect x="692.24" y="41.38" width="19.5" height="79.57" />
          <path d="M811.7,105.65c-4.28,0-7.42,3.24-7.42,7.52s3.13,7.52,7.42,7.52,7.42-3.24,7.42-7.52-3.13-7.52-7.42-7.52ZM811.7,119.54c-3.66,0-6.27-2.72-6.27-6.37s2.61-6.37,6.27-6.37,6.27,2.72,6.27,6.37-2.61,6.37-6.27,6.37Z" />
          <path d="M814.94,111.81c0-1.46-1.15-2.61-2.82-2.61h-3.34v7.83h1.15v-2.72h1.04l2.72,2.72h1.46l-2.72-2.72c1.46-.1,2.51-1.15,2.51-2.51ZM809.93,113.17v-2.82h2.19c1.04,0,1.67.63,1.67,1.46s-.52,1.36-1.67,1.36h-2.19Z" />
        </svg>
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

      {/* Preflight CTA */}
      <div className="mt-auto">
        <a
          href="https://newrelic.com/platform/ai-observability"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-2.5 py-2 rounded-md text-ink-subtle border border-accent-green/20 bg-accent-green/5 hover:bg-accent-green/10 hover:border-accent-green/50 hover:text-ink-base hover:shadow-[0_0_8px_rgba(28,231,131,0.35),0_0_20px_rgba(28,231,131,0.15)] transition-all duration-300 group/cta mb-2"
        >
          <svg
            width="11"
            height="13"
            viewBox="0 0 138 160"
            fill="currentColor"
            aria-hidden="true"
            className="flex-shrink-0 text-accent-green opacity-75 group-hover/cta:opacity-100 transition-opacity"
          >
            <polygon points="68.85 .18 8.05 35.28 34.54 50.57 68.85 30.76 111.21 55.22 111.21 104.14 76.9 123.95 76.9 154.53 137.7 119.43 137.7 39.93 68.85 .18" />
            <polygon points="42.36 94.97 42.36 143.89 68.85 159.18 68.85 79.68 0 39.93 0 70.51 42.36 94.97" />
          </svg>
          <span className="text-xs flex-1 leading-tight">Try AI Observability</span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="flex-shrink-0 opacity-50 group-hover/cta:opacity-80 transition-opacity"
          >
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>

        {/* Footer */}
        <div className="pt-3 border-t border-border-subtle">
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
        {versionInfo.installed !== null && (
          <div className="mt-2 px-2 flex items-center gap-1.5">
            <span className="text-[10px] text-ink-muted">v{versionInfo.installed}</span>
            <span className="text-[10px] text-ink-muted" aria-hidden="true">
              ·
            </span>
            <a
              href="https://github.com/newrelic-experimental/preflight"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View Preflight on GitHub"
              className="text-[10px] text-ink-subtle hover:text-ink-base transition-colors duration-150 flex items-center gap-0.5"
            >
              GitHub
              <ExternalLink size={8} aria-hidden="true" />
            </a>
          </div>
        )}
        {versionInfo.updateAvailable && versionInfo.latest !== null && (
          <div className="mt-0.5 px-2">
            <span className="text-[10px] text-accent-amber">v{versionInfo.latest} available</span>
          </div>
        )}
      </div>
    </aside>
  );
}
