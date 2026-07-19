import type { JSX } from 'react';

export type TabsSize = 'sm' | 'md';
export type TabsTone = 'green' | 'cyan';

export interface TabOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

export interface TabsProps<T extends string = string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<TabOption<T>>;
  readonly size?: TabsSize;
  readonly tone?: TabsTone;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const SIZE_CLASS: Record<TabsSize, string> = {
  sm: 'px-2 py-0.5 text-[10px] rounded-md',
  md: 'px-3 py-1 text-xs rounded-md',
};

const ACTIVE_TONE_CLASS: Record<TabsTone, string> = {
  green: 'bg-accent-green/20 text-accent-green font-medium',
  cyan: 'bg-accent-cyan/20 text-accent-cyan font-medium',
};

export function Tabs<T extends string = string>({
  value,
  onChange,
  options,
  size = 'md',
  tone = 'green',
  ariaLabel,
  className = '',
}: TabsProps<T>): JSX.Element {
  const wrapperClasses = ['inline-flex items-center gap-1', className].filter(Boolean).join(' ');
  return (
    <div role="tablist" aria-label={ariaLabel} className={wrapperClasses}>
      {options.map((opt) => {
        const active = opt.value === value;
        const tabClasses = [
          'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-deep',
          SIZE_CLASS[size],
          active ? ACTIVE_TONE_CLASS[tone] : 'text-ink-muted hover:text-ink-base',
        ].join(' ');
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={tabClasses}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
