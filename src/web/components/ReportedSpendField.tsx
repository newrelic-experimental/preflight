import { useState } from 'react';
import type { JSX } from 'react';

import {
  MAX_REPORTED_SPEND_USD,
  formatReportedAsOf,
  isReportedSpendStale,
  type ReportedSpend,
} from '../../lib/reported-spend.js';
import { formatUsd } from '../lib/format';
import { Button } from './ui';

export interface ReportedSpendFieldProps {
  readonly label: string;
  readonly entry: ReportedSpend | null;
  readonly pending: boolean;
  readonly onSave: (amountUsd: number | null) => void;
}

export function ReportedSpendField({
  label,
  entry,
  pending,
  onSave,
}: ReportedSpendFieldProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const amount = draft.trim() === '' ? null : Number(draft);
  const valid = amount !== null && Number.isFinite(amount) && amount >= 0;
  const stale = entry !== null && isReportedSpendStale(entry);

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <label htmlFor={`reported-${label}`} className="text-xs text-ink-muted w-36 shrink-0">
          {label}
        </label>
        <input
          id={`reported-${label}`}
          type="number"
          min={0}
          max={MAX_REPORTED_SPEND_USD}
          step="any"
          value={draft}
          placeholder={entry ? entry.amountUsd.toFixed(2) : 'none'}
          onChange={(e) => setDraft(e.target.value)}
          className="text-xs bg-surface-3 border border-border-subtle rounded-md px-2 py-1 w-48 focus:outline-none focus:border-accent-green text-ink-base placeholder:text-ink-muted"
        />
        <Button
          variant="primary"
          size="md"
          disabled={pending || !valid}
          onClick={() => {
            onSave(amount);
            setDraft('');
          }}
        >
          Save
        </Button>
        {entry && (
          <Button
            variant="secondary"
            size="md"
            disabled={pending}
            onClick={() => onSave(null)}
            aria-label={`Clear ${label}`}
          >
            Clear
          </Button>
        )}
      </div>
      {entry && (
        <div className={`mt-1 ml-[9.75rem] text-xs ${stale ? 'text-ink-muted' : 'text-ink-base'}`}>
          <span className={stale ? 'opacity-60' : ''}>
            {formatUsd(entry.amountUsd)} as of {formatReportedAsOf(entry, stale)}
          </span>
          {stale && <span className="ml-2 text-accent-amber">stale</span>}
        </div>
      )}
    </div>
  );
}
