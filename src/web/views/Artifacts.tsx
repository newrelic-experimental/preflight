import { useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  artifactViewUrl,
  fetchArtifacts,
  qk,
  UnavailableError,
  type ArtifactEntry,
  type ArtifactGroup,
  type ArtifactsResponse,
} from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Button, Card, Pill } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

const PRIMARY_WORKTREE_LABEL = 'primary';

function visibleGroups(groups: readonly ArtifactGroup[], needle: string): ArtifactGroup[] {
  if (needle === '') return [...groups];
  return groups.flatMap((group) => {
    if (group.label.toLowerCase().includes(needle)) return [group];
    const artifacts = group.artifacts.filter(
      (a) => a.name.toLowerCase().includes(needle) || a.relativePath.toLowerCase().includes(needle),
    );
    return artifacts.length > 0 ? [{ ...group, artifacts }] : [];
  });
}

function copyPath(path: string): void {
  void navigator.clipboard?.writeText(path).catch(() => undefined);
}

function ArtifactRow({ artifact }: { readonly artifact: ArtifactEntry }): JSX.Element {
  return (
    <li className="py-2 flex items-center gap-3 text-xs">
      <div className="min-w-0 flex-1">
        <a
          href={artifactViewUrl(artifact.path)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-cyan hover:underline transition-colors duration-150 font-medium break-all"
        >
          {artifact.name}
        </a>
        <div className="text-[11px] text-ink-muted truncate" title={artifact.path}>
          {artifact.relativePath}
        </div>
      </div>
      {artifact.worktreeLabel && artifact.worktreeLabel !== PRIMARY_WORKTREE_LABEL && (
        <Pill tone="neutral" size="sm">
          {artifact.worktreeLabel}
        </Pill>
      )}
      <span
        className="tabular-nums text-ink-subtle whitespace-nowrap"
        title={new Date(artifact.lastWrittenAt).toLocaleString()}
      >
        {formatRelativeTime(artifact.lastWrittenAt)}
      </span>
      <Button variant="ghost" size="sm" onClick={() => copyPath(artifact.path)}>
        Copy path
      </Button>
    </li>
  );
}

function GroupCard({ group }: { readonly group: ArtifactGroup }): JSX.Element {
  return (
    <Card padding="sm" tone="static" className="mb-3">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-sm font-medium text-ink-base truncate" title={group.key}>
          {group.label}
        </h2>
        <Pill tone="neutral" size="sm">
          {group.kind === 'repo' ? 'repo' : 'folder'}
        </Pill>
        <span className="ml-auto text-[11px] text-ink-muted tabular-nums">
          {group.artifacts.length}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-border-subtle">
        {group.artifacts.map((artifact) => (
          <ArtifactRow key={artifact.path} artifact={artifact} />
        ))}
      </ul>
    </Card>
  );
}

export function Artifacts(): JSX.Element {
  const [filter, setFilter] = useState('');
  const { data, isLoading, error, refetch } = useQuery<ArtifactsResponse, Error>({
    queryKey: qk.artifacts,
    queryFn: ({ signal }) => fetchArtifacts(signal),
    refetchInterval: 10_000,
    // A 503 means the feature is off. Retrying it only delays the explanation.
    retry: (failureCount, err) => !(err instanceof UnavailableError) && failureCount < 2,
  });

  const needle = filter.trim().toLowerCase();
  const groups = visibleGroups(data?.groups ?? [], needle);
  const disabled = error instanceof UnavailableError;

  return (
    <section>
      <header className="flex items-baseline justify-between gap-3 mb-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold gradient-text">Artifacts</h1>
          <Pill tone="warning" size="sm">
            Experimental
          </Pill>
        </div>
        {!disabled && (
          <input
            type="search"
            aria-label="Filter artifacts"
            placeholder="Filter by name, path or repo"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs bg-surface-3 border border-border-subtle rounded-md px-2 py-1 w-64 text-ink-base placeholder:text-ink-muted"
          />
        )}
      </header>

      {isLoading && <EmptyState icon="clock" variant="loading" title="Loading..." />}

      {disabled && (
        <EmptyState
          icon="code"
          title="Artifacts are turned off"
          subtitle={
            'Set "experimentalArtifacts": true in ~/.newrelic-preflight/config.json, or set NEW_RELIC_AI_EXPERIMENTAL_ARTIFACTS=true, then restart Preflight.'
          }
        />
      )}

      {error && !disabled && (
        <div className="text-accent-red text-xs flex items-center gap-2">
          <span>Error loading artifacts.</span>
          <button
            onClick={() => void refetch()}
            className="text-[10px] text-ink-muted hover:text-ink-base transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && data && data.groups.length === 0 && (
        <EmptyState
          icon="code"
          title="No HTML artifacts yet."
          subtitle="Preflight lists .html files your agent writes with Write or Edit."
        />
      )}

      {!isLoading && !error && data && data.groups.length > 0 && groups.length === 0 && (
        <div className="text-[11px] text-ink-muted">No matching artifacts.</div>
      )}

      {!isLoading && !error && groups.map((group) => <GroupCard key={group.key} group={group} />)}
    </section>
  );
}
