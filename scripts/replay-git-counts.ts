#!/usr/bin/env tsx
/**
 * Replays every Bash tool call in the local Claude Code transcripts for a
 * date window through the git workspace pipeline (recorder, git-log
 * hydration, reconcile, report) and prints the numbers the Git tab's
 * weekly panel would show. Compare them against `gh pr list --author @me`
 * and `git log --all --author=<you>` for the same window.
 *
 * Usage:
 *   npx tsx scripts/replay-git-counts.ts <since YYYY-MM-DD> <until YYYY-MM-DD> [--unmatched]
 *
 * `--unmatched` lists every hook-observed commit the reconcile step could
 * not pair with a git-log commit, with the evidence needed to say why:
 * success flag, tool duration, and distance to the nearest hydrated commit
 * in the same repo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ActivityStore } from '../src/metrics/git-activity-store.js';
import {
  GIT_LOG_SESSION_ID,
  GitActivityRecorder,
  type GitActivityRecord,
} from '../src/metrics/git-activity-recorder.js';
import {
  WorktreeIdentityResolver,
  type WorktreeIdentity,
} from '../src/metrics/git-workspace-identity.js';
import { isCountedCommit, reconcileHydratedCommits } from '../src/metrics/git-workspace-report.js';
import { GitWorkspaceReporter } from '../src/metrics/git-workspace-reporter.js';
import {
  collectCommitsAcrossRepos,
  resolveAuthorEmail,
  type CollectedCommit,
} from '../src/metrics/local-session-aggregator.js';
import type { ToolCallRecord } from '../src/storage/types.js';

const [sinceArg, untilArg, flag] = process.argv.slice(2);
if (!sinceArg || !untilArg) {
  console.error('usage: replay-git-counts.ts <since YYYY-MM-DD> <until YYYY-MM-DD> [--unmatched]');
  process.exit(2);
}
const since = new Date(`${sinceArg}T00:00:00`).getTime();
const until = new Date(`${untilArg}T00:00:00`).getTime();

function* jsonlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.name.endsWith('.jsonl') && statSync(full).mtimeMs > since) yield full;
  }
}

interface TranscriptLine {
  readonly timestamp?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly message?: { readonly content?: unknown };
}

interface ContentBlock {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: { readonly command?: string };
  readonly tool_use_id?: string;
  readonly is_error?: boolean;
}

function loadBashRecords(): ToolCallRecord[] {
  const uses = new Map<string, ToolCallRecord>();
  const results = new Map<string, { readonly isError: boolean; readonly ts: number }>();
  for (const file of jsonlFiles(join(homedir(), '.claude', 'projects'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('tool_use')) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content) || !entry.timestamp) continue;
      const ts = Date.parse(entry.timestamp);
      for (const block of content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          results.set(block.tool_use_id, { isError: block.is_error === true, ts });
        }
        if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
          if (ts < since || ts >= until) continue;
          uses.set(block.id, {
            id: block.id,
            sessionId: entry.sessionId ?? 'unknown',
            toolName: 'Bash',
            toolUseId: block.id,
            timestamp: ts,
            durationMs: null,
            success: true,
            command: block.input?.command ?? '',
            cwd: entry.cwd,
          });
        }
      }
    }
  }
  return [...uses.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((record) => {
      const result = results.get(record.id);
      return {
        ...record,
        success: !result?.isError,
        durationMs: result ? Math.max(0, result.ts - record.timestamp) : null,
      };
    });
}

function repoRootsOf(records: readonly ToolCallRecord[]): string[] {
  const roots = new Set<string>();
  for (const cwd of new Set(records.map((r) => r.cwd as string | undefined))) {
    if (!cwd) continue;
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.status === 0) roots.add(r.stdout.trim());
  }
  return [...roots];
}

const records = loadBashRecords();
const commits = collectCommitsAcrossRepos(
  repoRootsOf(records),
  sinceArg,
  resolveAuthorEmail(process.cwd()),
);

if (flag === '--unmatched') {
  printUnmatched(records, commits);
} else {
  printHeadline(records, commits);
}

function printHeadline(
  toolCalls: readonly ToolCallRecord[],
  hydrated: readonly CollectedCommit[],
): void {
  const reporter = new GitWorkspaceReporter();
  for (const record of toolCalls) reporter.recordToolCall(record);
  reporter.hydrateGitLog(hydrated);
  const report = reporter.report({ scope: { kind: 'all' }, since, until });
  console.log(
    JSON.stringify(
      {
        toolCalls: toolCalls.length,
        hydratedGitLogCommits: hydrated.length,
        commits: report.metrics.commitCount,
        prsCreated: report.metrics.prMetrics.created,
        prsMerged: report.metrics.prMetrics.merged,
        rows: report.rows
          .filter((r) => r.metrics.commitCount > 0 || r.metrics.prMetrics.created > 0)
          .map((r) => ({
            workspace: `${r.identity.repoName ?? '-'}/${r.identity.worktreeLabel}`,
            commits: r.metrics.commitCount,
            prsCreated: r.metrics.prMetrics.created,
          })),
      },
      null,
      2,
    ),
  );
}

function printUnmatched(
  toolCalls: readonly ToolCallRecord[],
  hydrated: readonly CollectedCommit[],
): void {
  const resolver = new WorktreeIdentityResolver();
  const store = new ActivityStore<GitActivityRecord>();
  const recorder = new GitActivityRecorder(store, resolver);
  const identities = new Map<string, WorktreeIdentity>();
  for (const record of toolCalls) {
    recorder.recordToolCall(record);
    const identity = resolver.resolve(record.cwd as string | undefined);
    if (identity) identities.set(identity.worktreeKey, identity);
  }
  const hydratedRecords: GitActivityRecord[] = [];
  for (const c of hydrated) {
    const identity = resolver.resolve(c.root);
    if (!identity) continue;
    identities.set(identity.worktreeKey, identity);
    hydratedRecords.push({
      kind: 'git',
      sessionId: GIT_LOG_SESSION_ID,
      timestamp: c.timestamp,
      recordId: `gitlog:${c.hash}`,
      workspaceKey: identity.worktreeKey,
      gitEvent: {
        timestamp: c.timestamp,
        type: 'commit',
        command: `git commit (${c.hash})`,
        success: true,
        durationMs: null,
        repo: c.repo,
        subject: c.subject,
        url: c.url,
        hash: c.hash,
      },
    });
  }
  const live = store.query({ since, until });
  const merged = reconcileHydratedCommits([...live, ...hydratedRecords], identities);
  const repoKeyOf = (r: GitActivityRecord): string =>
    identities.get(r.workspaceKey)?.repoKey ?? r.workspaceKey;
  const hydratedByRepo = new Map<string, number[]>();
  for (const h of hydratedRecords) {
    const key = repoKeyOf(h);
    hydratedByRepo.set(key, [...(hydratedByRepo.get(key) ?? []), h.timestamp]);
  }
  const unmatched = merged.filter(
    (r) => r.kind === 'git' && isCountedCommit(r.gitEvent) && !r.gitEvent.hash,
  );
  console.log(
    `live records=${live.length} hydrated=${hydratedRecords.length} merged=${merged.length} unmatched hook commits=${unmatched.length}`,
  );
  for (const r of unmatched) {
    if (r.kind !== 'git') continue;
    const identity = identities.get(r.workspaceKey);
    const candidates = identity
      ? (hydratedByRepo.get(repoKeyOf(r)) ?? [])
      : hydratedRecords.map((h) => h.timestamp);
    const nearest = candidates.reduce(
      (best, t) => Math.min(best, Math.abs(t - r.timestamp)),
      Number.POSITIVE_INFINITY,
    );
    const where = identity ? `${identity.repoName}/${identity.worktreeLabel}` : 'UNATTRIBUTED';
    const nearestText = Number.isFinite(nearest) ? `${Math.round(nearest / 1000)}s` : '-';
    const command = (r.gitEvent.command ?? '').replace(/\s+/g, ' ').slice(0, 90);
    console.log(
      `${where} ok=${r.gitEvent.success} dur=${r.gitEvent.durationMs}ms nearestHydrated=${nearestText} :: ${command}`,
    );
  }
}
