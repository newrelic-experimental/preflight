import type { JSX, ReactNode } from 'react';

interface AnimatedCardProps {
  readonly children: ReactNode;
  readonly index?: number;
  readonly className?: string;
}

export function AnimatedCard({
  children,
  index = 0,
  className = '',
}: AnimatedCardProps): JSX.Element {
  const delay = `${index * 120}ms`;

  return (
    <div className={`animate-card-enter ${className}`} style={{ animationDelay: delay }}>
      {children}
    </div>
  );
}
