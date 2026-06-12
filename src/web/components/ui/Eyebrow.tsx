import type { ReactNode } from 'react';

export type EyebrowAs = 'div' | 'h2' | 'h3';

export interface EyebrowProps {
  readonly children: ReactNode;
  readonly as?: EyebrowAs;
  readonly className?: string;
}

export function Eyebrow({ children, as = 'div', className = '' }: EyebrowProps): JSX.Element {
  const classes = ['text-[10px] text-ink-muted uppercase tracking-wider font-medium', className]
    .filter(Boolean)
    .join(' ');
  if (as === 'h2') {
    return <h2 className={classes}>{children}</h2>;
  }
  if (as === 'h3') {
    return <h3 className={classes}>{children}</h3>;
  }
  return <div className={classes}>{children}</div>;
}
