type EmptyIcon = 'radar' | 'code' | 'timeline' | 'checkmark' | 'clock';

type EmptyStateVariant = 'empty' | 'loading';

interface EmptyStateProps {
  readonly icon?: EmptyIcon;
  readonly title: string;
  readonly subtitle?: string;
  readonly variant?: EmptyStateVariant;
}

function RadarIcon(): JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="20"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        opacity="0.3"
      />
      <circle
        cx="24"
        cy="24"
        r="13"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        opacity="0.3"
      />
      <circle cx="24" cy="24" r="6" stroke="var(--color-ink-muted)" strokeWidth="1" opacity="0.3" />
      <line
        x1="24"
        y1="24"
        x2="24"
        y2="4"
        stroke="var(--color-accent-green)"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="animate-radar-sweep"
      />
      <circle cx="24" cy="24" r="2" fill="var(--color-accent-green)" />
    </svg>
  );
}

function CodeIcon(): JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M16 14 L6 24 L16 34"
        stroke="var(--color-ink-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M32 14 L42 24 L32 34"
        stroke="var(--color-ink-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="24"
        y1="18"
        x2="24"
        y2="30"
        stroke="var(--color-accent-green)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.8"
      />
    </svg>
  );
}

function TimelineIcon(): JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <line
        x1="4"
        y1="24"
        x2="44"
        y2="24"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        opacity="0.4"
      />
      <circle cx="12" cy="24" r="3" stroke="var(--color-ink-muted)" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="3" stroke="var(--color-accent-green)" strokeWidth="1.5" />
      <circle cx="36" cy="24" r="3" stroke="var(--color-ink-muted)" strokeWidth="1.5" />
      <line
        x1="12"
        y1="16"
        x2="12"
        y2="20"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.5"
      />
      <line
        x1="24"
        y1="16"
        x2="24"
        y2="20"
        stroke="var(--color-accent-green)"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.7"
      />
      <line
        x1="36"
        y1="16"
        x2="36"
        y2="20"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

function CheckmarkIcon(): JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="18"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        opacity="0.3"
      />
      <path
        d="M16 24 L22 30 L34 18"
        stroke="var(--color-accent-green)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon(): JSX.Element {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="18"
        stroke="var(--color-ink-muted)"
        strokeWidth="1"
        opacity="0.3"
      />
      <path
        d="M24 14 L24 24 L31 28"
        stroke="var(--color-ink-subtle)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICON_MAP: Record<EmptyIcon, () => JSX.Element> = {
  radar: RadarIcon,
  code: CodeIcon,
  timeline: TimelineIcon,
  checkmark: CheckmarkIcon,
  clock: ClockIcon,
};

function LoadingDot(): JSX.Element {
  return (
    <div
      className="flex items-center justify-center"
      style={{ width: 48, height: 48 }}
      aria-hidden="true"
    >
      <span
        className="rounded-full animate-pulse"
        style={{
          width: 10,
          height: 10,
          backgroundColor: 'var(--color-accent-green)',
          boxShadow: '0 0 0 4px color-mix(in srgb, var(--color-accent-green) 15%, transparent)',
        }}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
  variant = 'empty',
}: EmptyStateProps): JSX.Element {
  const Icon = icon !== undefined ? ICON_MAP[icon] : undefined;
  return (
    <div className="py-8 flex flex-col items-center justify-center gap-3">
      {variant === 'loading' ? <LoadingDot /> : Icon && <Icon />}
      <span className="text-sm font-medium text-ink-subtle">{title}</span>
      {subtitle && (
        <span className="text-xs text-ink-muted text-center max-w-[240px]">{subtitle}</span>
      )}
    </div>
  );
}
