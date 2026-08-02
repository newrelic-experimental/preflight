import { useId, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export interface InfoTooltipProps {
  readonly text: string;
}

interface TooltipPosition {
  readonly top: number;
  readonly left: number;
}

export function InfoTooltip({ text }: InfoTooltipProps): JSX.Element {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ top: 0, left: 0 });

  const openTooltip = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({ top: rect.bottom + 4, left: rect.left });
    }
    setIsOpen(true);
  };

  const closeTooltip = (): void => {
    setIsOpen(false);
  };

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label="What is this?"
        aria-describedby={tooltipId}
        onMouseEnter={openTooltip}
        onFocus={openTooltip}
        onMouseLeave={closeTooltip}
        onBlur={closeTooltip}
        className="text-ink-muted hover:text-ink-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-deep rounded-full"
      >
        <Info size={12} aria-hidden="true" focusable="false" />
      </button>
      {isOpen &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            className="fixed z-50 w-60 max-w-[240px] rounded-md glass-card glass-card-static p-2 text-[10px] leading-snug text-ink-subtle"
            style={{ top: position.top, left: position.left }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
