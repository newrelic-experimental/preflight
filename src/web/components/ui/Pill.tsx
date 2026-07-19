import type { HTMLAttributes, JSX, ReactNode } from 'react';

export type PillTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type PillSize = 'sm' | 'md';

type NativeSpanProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className'>;

export interface PillProps extends NativeSpanProps {
  readonly children: ReactNode;
  readonly tone?: PillTone;
  readonly size?: PillSize;
  readonly uppercase?: boolean;
  readonly bordered?: boolean;
  readonly className?: string;
}

const TONE_CLASS: Record<PillTone, string> = {
  neutral: 'bg-surface-5 text-ink-subtle',
  info: 'bg-accent-blue/15 text-accent-blue',
  success: 'bg-accent-green/15 text-accent-green',
  warning: 'bg-accent-amber/20 text-accent-amber',
  danger: 'bg-accent-red/20 text-accent-red',
};

const TONE_BORDER_CLASS: Record<PillTone, string> = {
  neutral: 'border border-border-medium',
  info: 'border border-accent-blue/30',
  success: 'border border-accent-green/30',
  warning: 'border border-accent-amber/30',
  danger: 'border border-accent-red/30',
};

const SIZE_CLASS: Record<PillSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-[11px]',
};

export function Pill({
  children,
  tone = 'neutral',
  size = 'md',
  uppercase = false,
  bordered = false,
  className = '',
  ...rest
}: PillProps): JSX.Element {
  const classes = [
    'inline-flex items-center gap-1 rounded-full',
    TONE_CLASS[tone],
    SIZE_CLASS[size],
    bordered ? TONE_BORDER_CLASS[tone] : '',
    uppercase ? 'uppercase tracking-wider font-semibold' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
