export type LiveBadgeSize = 'sm' | 'md';

export interface LiveBadgeProps {
  readonly label?: string;
  readonly pulse?: boolean;
  readonly size?: LiveBadgeSize;
  readonly className?: string;
}

const SIZE_CLASS: Record<LiveBadgeSize, string> = {
  sm: 'text-[9px]',
  md: 'text-[10px]',
};

export function LiveBadge({
  label = 'LIVE',
  pulse = true,
  size = 'md',
  className = '',
}: LiveBadgeProps): JSX.Element {
  const classes = [
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full',
    'bg-accent-cyan/15 text-accent-cyan uppercase tracking-wider font-semibold',
    SIZE_CLASS[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes}>
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full bg-accent-cyan ${pulse ? 'animate-pulse' : ''}`}
      />
      {label}
    </span>
  );
}
