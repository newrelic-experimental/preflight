import { useEffect } from 'react';
import { X } from 'lucide-react';

import { Button } from './ui';

interface ShortcutOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const shortcuts = [
  { keys: ['?'], description: 'Show this help' },
  { keys: ['t'], description: 'Toggle light/dark mode' },
  { keys: ['g', 'h'], description: 'Go to Today' },
  { keys: ['g', 's'], description: 'Go to Sessions' },
  { keys: ['g', 'i'], description: 'Go to History' },
  { keys: ['g', 'a'], description: 'Go to Audit' },
  { keys: ['g', 'v'], description: 'Go to Git Efficiency' },
  { keys: ['g', 'e'], description: 'Go to Settings' },
  { keys: ['g', 'l'], description: 'Go to Alerts' },
  { keys: ['Esc'], description: 'Close overlay' },
];

export function ShortcutOverlay({ open, onClose }: ShortcutOverlayProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-card animate-overlay-enter max-w-sm w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink-base">Keyboard Shortcuts</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="px-1 py-1"
          >
            <X size={16} />
          </Button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.description} className="flex items-center justify-between text-sm">
              <span className="text-ink-subtle">{shortcut.description}</span>
              <span className="flex gap-1">
                {shortcut.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-block px-1.5 py-0.5 text-[11px] font-mono bg-bg-elevated rounded-md border border-border-subtle text-ink-base"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
