import type { JSX, ReactNode } from 'react';

export interface SectionHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function SectionHeader({
  title,
  subtitle,
  action,
  className = '',
}: SectionHeaderProps): JSX.Element {
  const wrapperClasses = ['flex items-start justify-between gap-3 mb-3', className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={wrapperClasses}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-base">{title}</div>
        {subtitle !== undefined && subtitle !== null && (
          <div className="text-xs text-ink-muted">{subtitle}</div>
        )}
      </div>
      {action !== undefined && action !== null && (
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      )}
    </div>
  );
}
