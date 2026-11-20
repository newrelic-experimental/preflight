import { useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  fetchSettings,
  fetchUsageReportsPreview,
  qk,
  type SettingsResponse,
  type UsageReportEvent,
  type UsageReportsPreview,
} from '../api/client';
import { Card, SectionHeader } from './ui';
import { UsageReportsContents } from './UsageReportsContents';

function EventList({ events }: { events: readonly UsageReportEvent[] }): JSX.Element {
  return (
    <div className="mt-1 text-[10px] font-mono bg-surface-3 rounded p-2 whitespace-pre-wrap break-all space-y-1">
      {events.map((e, i) => (
        <div key={i}>{JSON.stringify(e)}</div>
      ))}
    </div>
  );
}

/** The dashboard's `preflight usage-reports show`: the next report, queued days and recent sends. */
function Payloads({ preview }: { preview: UsageReportsPreview }): JSX.Element {
  return (
    <div className="mt-3 space-y-3 text-xs text-ink-muted">
      <div>
        <div className="font-medium text-ink">Start report, sent once a day</div>
        <EventList events={preview.start} />
      </div>
      <div>
        <div className="font-medium text-ink">Daily summaries waiting to be sent</div>
        {preview.queued.length === 0 ? (
          <p className="mt-1">None.</p>
        ) : (
          preview.queued.map((day) => (
            <div key={day.date} className="mt-1">
              {day.date}
              {day.today && ' (today, still counting)'}
              <EventList events={day.events} />
            </div>
          ))
        )}
      </div>
      <div>
        <div className="font-medium text-ink">
          Sent
          {preview.sentTotal > 0 &&
            ` (${preview.sentTotal} ${preview.sentTotal === 1 ? 'event' : 'events'}, newest last)`}
        </div>
        {preview.sentTotal === 0 ? (
          <p className="mt-1">Nothing yet.</p>
        ) : (
          <EventList events={preview.sent.map((s) => ({ sentAt: s.sentAt, ...s.event }))} />
        )}
      </div>
    </div>
  );
}

export function UsageReportsPanel(): JSX.Element | null {
  const [showPayloads, setShowPayloads] = useState(false);
  const { data } = useQuery<SettingsResponse>({
    queryKey: qk.settings,
    queryFn: ({ signal }) => fetchSettings(signal),
  });
  const preview = useQuery<UsageReportsPreview>({
    queryKey: qk.usageReportsPreview,
    queryFn: ({ signal }) => fetchUsageReportsPreview(signal),
    enabled: showPayloads,
  });
  const ur = data?.usageReports;
  if (!ur) return null;

  return (
    <Card padding="md" className="mb-4">
      <SectionHeader title="Usage reports" subtitle={ur.description} />
      <UsageReportsContents view={ur} inSettings />
      <button
        type="button"
        className="mt-3 text-xs underline text-ink-muted hover:text-ink-base"
        aria-expanded={showPayloads}
        onClick={() => setShowPayloads((v) => !v)}
      >
        {showPayloads ? 'Hide exact payloads' : 'Show exact payloads'}
      </button>
      {showPayloads && preview.isLoading && <p className="mt-2 text-xs">Loading…</p>}
      {showPayloads && preview.isError && (
        <p className="mt-2 text-xs text-accent-red">Couldn’t load the payloads.</p>
      )}
      {showPayloads && preview.data && <Payloads preview={preview.data} />}
    </Card>
  );
}
