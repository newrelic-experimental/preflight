import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchTaskCompletion, qk, type TaskCompletionMetrics } from '../api/client';
import { formatDuration } from '../lib/format';
import { Kpi } from './Kpi';
import { Panel } from './ui/Panel';

const REFETCH_MS = 10_000;

export function TaskCompletionPanel(): JSX.Element {
  const { data, isPending } = useQuery<TaskCompletionMetrics>({
    queryKey: qk.taskCompletion,
    queryFn: ({ signal }) => fetchTaskCompletion(signal),
    refetchInterval: REFETCH_MS,
  });

  const completed = data?.completedTasks ?? 0;

  return (
    <Panel
      title="Tasks"
      tooltip="Tasks completed since this dashboard started, with average duration and tool calls per task."
    >
      {isPending ? (
        <div className="text-[12px] text-ink-muted">Loading tasks…</div>
      ) : completed === 0 ? (
        <div className="text-[12px] text-ink-muted">
          No completed tasks yet. Tasks appear here once one finishes.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Kpi label="completed" value={String(completed)} />
          <Kpi
            label="avg duration"
            value={data?.avgTaskDurationMs != null ? formatDuration(data.avgTaskDurationMs) : '—'}
          />
          <Kpi
            label="avg tool calls / task"
            value={data?.avgToolCallsPerTask != null ? data.avgToolCallsPerTask.toFixed(1) : '—'}
          />
        </div>
      )}
    </Panel>
  );
}
