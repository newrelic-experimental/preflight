import type { JSX, ReactNode } from 'react';

import { Card } from './Card';
import { Eyebrow } from './Eyebrow';
import { InfoTooltip } from './InfoTooltip';

export interface PanelProps {
  readonly title: string;
  readonly tooltip?: string;
  readonly subtitle?: string;
  readonly action?: ReactNode;
  readonly footnote?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Panel({
  title,
  tooltip,
  subtitle,
  action,
  footnote,
  className,
  children,
}: PanelProps): JSX.Element {
  return (
    <Card padding="md" className={className}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Eyebrow>{title}</Eyebrow>
          {tooltip && <InfoTooltip text={tooltip} />}
          {subtitle && <span className="text-[10px] text-ink-muted">{subtitle}</span>}
        </div>
        {action && <div className="flex items-center gap-1.5">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
      {footnote && <div className="mt-2 text-[10px] italic text-ink-muted">{footnote}</div>}
    </Card>
  );
}
