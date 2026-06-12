import type { ReactNode } from 'react';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';
export type CardTone = 'default' | 'elevated' | 'static' | 'danger' | 'warning';
export type CardGlow = 'none' | 'green' | 'purple';

export interface CardProps {
  readonly children: ReactNode;
  readonly padding?: CardPadding;
  readonly tone?: CardTone;
  readonly glow?: CardGlow;
  readonly className?: string;
}

const PADDING_CLASS: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const TONE_CLASS: Record<CardTone, string> = {
  default: 'glass-card',
  elevated: 'glass-card bg-surface-5',
  static: 'glass-card glass-card-static',
  danger: 'glass-card glass-card-static border border-accent-red/60',
  warning: 'glass-card glass-card-static border border-accent-amber/40',
};

const GLOW_CLASS: Record<CardGlow, string> = {
  none: '',
  green: 'glow-green',
  purple: 'glow-purple',
};

export function Card({
  children,
  padding = 'md',
  tone = 'default',
  glow = 'none',
  className = '',
}: CardProps): JSX.Element {
  const classes = [TONE_CLASS[tone], PADDING_CLASS[padding], GLOW_CLASS[glow], className]
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}
