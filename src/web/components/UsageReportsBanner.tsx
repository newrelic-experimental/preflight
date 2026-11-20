import { useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, patchSettings, qk, type SettingsResponse } from '../api/client';
import { UsageReportsContents } from './UsageReportsContents';

/**
 * Asks once whether to share anonymous usage statistics. Shown only while the
 * install is unasked and under the prompt limit. "Yes" and "No" carry equal
 * weight; "Not now" counts toward the limit and the question comes back later.
 */
export function UsageReportsBanner(): JSX.Element | null {
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery<SettingsResponse>({
    queryKey: qk.settings,
    queryFn: ({ signal }) => fetchSettings(signal),
  });
  const mutation = useMutation({
    mutationFn: (answer: 'yes' | 'no' | 'dismissed') => patchSettings({ usageReports: answer }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.settings }),
  });

  const ur = data?.usageReports;
  if (hidden || !ur || ur.state !== 'unset' || !ur.canAsk) return null;

  const choose = (answer: 'yes' | 'no' | 'dismissed'): void => {
    setHidden(true);
    mutation.mutate(answer);
  };
  const button =
    'px-3 py-1 rounded border border-bg-line text-xs font-semibold text-ink ' +
    'hover:bg-bg-line/40 focus:outline-none focus:ring-2 focus:ring-accent-cyan/50';

  return (
    <div
      role="region"
      aria-label="Usage statistics"
      className="bg-bg-panel border-b border-bg-line px-4 py-3 flex flex-wrap items-center gap-3 text-xs"
    >
      <div className="flex-1 min-w-[16rem]">
        <p className="font-semibold text-ink">
          Share anonymous usage statistics with the Preflight team at New Relic?
        </p>
        <p className="text-ink-muted mt-1">
          A daily report of how you use Preflight, identified only by a random install ID.{' '}
          <button
            type="button"
            className="underline"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide what’s sent' : 'What’s sent'}
          </button>
        </p>
        {expanded && (
          <div className="mt-2">
            <UsageReportsContents view={ur} />
          </div>
        )}
      </div>
      <button type="button" className={button} onClick={() => choose('yes')}>
        Yes
      </button>
      <button type="button" className={button} onClick={() => choose('no')}>
        No
      </button>
      <button
        type="button"
        className="text-ink-muted underline text-xs"
        onClick={() => choose('dismissed')}
      >
        Not now
      </button>
    </div>
  );
}
