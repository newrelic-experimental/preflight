import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'disabled' | 'type'
>;

export interface ButtonProps extends NativeButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly className?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-green/10 border border-accent-green/40 text-accent-green hover:bg-accent-green/20',
  secondary:
    'bg-surface-5 border border-border-medium text-ink-subtle hover:border-border-strong hover:text-ink-base',
  ghost:
    'bg-transparent border border-transparent text-ink-muted hover:text-ink-base hover:bg-surface-5',
  danger:
    'bg-surface-5 border border-border-subtle text-ink-muted hover:border-accent-red hover:text-accent-red',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-xs',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  loading = false,
  type = 'button',
  className = '',
  ...rest
}: ButtonProps): JSX.Element {
  const isDisabled = disabled || loading;
  const classes = [
    'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-deep',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    isDisabled ? 'opacity-50 cursor-not-allowed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={classes}
      {...rest}
    >
      {children}
    </button>
  );
}
