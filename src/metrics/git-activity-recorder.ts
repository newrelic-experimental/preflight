import type { ToolCallRecord } from '../storage/types.js';
import type { KeyedRecord } from './git-activity-store.js';
import { ActivityStore } from './git-activity-store.js';
import {
  classifyGitSegments,
  processGhCommand,
  splitShellSegments,
  type GitEvent,
} from './git-event-classifier.js';
import { UNATTRIBUTED_WORKSPACE_KEY, WorktreeIdentityResolver } from './git-workspace-identity.js';
import { stripHeredocBodies } from './local-session-aggregator.js';
import type { PrEvent } from './git-efficiency-tracker.js';

/** `sessionId` used for commit records hydrated from `git log` rather than
 *  observed live via a hook. Exported so `reconcileHydratedCommits`
 *  (git-workspace-report.ts) can exclude it from a workspace's
 *  Claude-Code-session count — a hydrated commit didn't come from any
 *  session at all. */
export const GIT_LOG_SESSION_ID = 'git-log';

/** One observed activity, tagged with which workspace (repo+worktree) it
 *  happened in. `kind` discriminates what's meaningful beyond the base
 *  fields — a future coaching check (e.g. "did you build before pushing")
 *  needs `edit`/`verify` activity retained, which the old tracker discarded
 *  at ingest for anything that wasn't a recognized git command. */
export type GitActivityRecord = KeyedRecord & {
  /** The Claude Code session that produced this activity — 'unknown' when
   *  the source ToolCallRecord had none (matches makeRecordId's own
   *  fallback below). Powers "how many sessions touched this workspace"
   *  in the Repos & Worktrees tree, so a click there can deep-link straight
   *  to those exact sessions instead of only approximating by repo name. */
  readonly sessionId: string;
} & (
    | { readonly kind: 'git'; readonly gitEvent: GitEvent }
    | { readonly kind: 'edit'; readonly filePath: string }
    | { readonly kind: 'verify'; readonly verify: 'build' | 'test' }
    | { readonly kind: 'pr'; readonly prEvent: PrEvent }
  );

/** Detected PR action from gh CLI or MCP tools. */
const MCP_PR_TOOL_ACTION: Record<string, PrEvent['action']> = {
  create_pull_request: 'create',
  update_pull_request: 'edit',
};

export class GitActivityRecorder {
  constructor(
    private readonly store: ActivityStore<GitActivityRecord>,
    private readonly identityResolver: WorktreeIdentityResolver,
  ) {}

  /** Mirrors GitEfficiencyTracker.recordToolCall's existing dispatch logic —
   *  ingest file edits, build/test commands, MCP/gh-CLI PR actions, and
   *  classified git commands, turning each into zero or more GitActivityRecord(s)
   *  and pushing them into the store.
   */
  recordToolCall(record: ToolCallRecord): void {
    const cwd = record.cwd as string | undefined;

    // Track file edits (non-git tool calls that modify files)
    if (record.toolName === 'Edit' || record.toolName === 'Write') {
      const filePath = record.filePath as string | undefined;
      if (filePath) {
        this.ingestActivity({
          sessionId: record.sessionId ?? 'unknown',
          kind: 'edit',
          filePath,
          timestamp: record.timestamp,
          recordId: this.makeRecordId(record, 'edit'),
          workspaceKey: this.resolveWorkspaceKey(cwd),
        });
      }
    }

    // Track build/test commands for "verify before push" metric
    if (record.isTestCommand) {
      this.ingestActivity({
        sessionId: record.sessionId ?? 'unknown',
        kind: 'verify',
        verify: 'test',
        timestamp: record.timestamp,
        recordId: this.makeRecordId(record, 'verify-test'),
        workspaceKey: this.resolveWorkspaceKey(cwd),
      });
    }
    if (record.isBuildCommand) {
      this.ingestActivity({
        sessionId: record.sessionId ?? 'unknown',
        kind: 'verify',
        verify: 'build',
        timestamp: record.timestamp,
        recordId: this.makeRecordId(record, 'verify-build'),
        workspaceKey: this.resolveWorkspaceKey(cwd),
      });
    }

    // MCP tool calls (e.g. the GitHub MCP server's create_pull_request /
    // update_pull_request)
    const mcpPrAction = MCP_PR_TOOL_ACTION[record.toolName];
    if (mcpPrAction) {
      this.ingestActivity({
        sessionId: record.sessionId ?? 'unknown',
        kind: 'pr',
        prEvent: { timestamp: record.timestamp, action: mcpPrAction, prNumber: null },
        timestamp: record.timestamp,
        recordId: this.makeRecordId(record, 'pr-mcp'),
        workspaceKey: this.resolveWorkspaceKey(cwd),
      });
    }

    const rawCommand = record.command as string | undefined;
    if (!rawCommand) return;
    // Classify on the command *minus* any inline script bodies: a heredoc
    // that merely mentions git/gh words is not a git or PR operation.
    const command = stripHeredocBodies(rawCommand);
    const segments = splitShellSegments(command);

    // Track GitHub CLI PR commands. Each segment is checked on its own — a
    // `gh` invocation can be chained before or after a `git` command, or
    // follow a heredoc script on its own newline-separated segment.
    for (let i = 0; i < segments.length; i++) {
      const prEvent = processGhCommand(segments[i].trim(), record.timestamp);
      if (!prEvent) continue;
      // A failed `gh pr create` made no PR — nothing to count. Every other
      // verb stays real even on failure: `gh pr checks` exits non-zero when
      // checks are failing, and that's still a genuine checks view.
      if (prEvent.action === 'create' && record.success === false) continue;
      this.ingestActivity({
        sessionId: record.sessionId ?? 'unknown',
        kind: 'pr',
        prEvent,
        timestamp: record.timestamp,
        // Indexed so a compound command chaining two `gh pr` calls (rare,
        // but possible) doesn't collide on the same recordId.
        recordId: this.makeRecordId(record, `pr-gh-${i}`),
        workspaceKey: this.resolveWorkspaceKey(cwd),
      });
    }

    const resolveRepo = (dir: string | null): string | null =>
      this.identityResolver.resolve(dir)?.repoName ?? null;

    classifyGitSegments(command, record, resolveRepo).forEach(({ event }, i) => {
      this.ingestActivity({
        sessionId: record.sessionId ?? 'unknown',
        kind: 'git',
        gitEvent: event,
        timestamp: record.timestamp,
        recordId: this.makeRecordId(record, `git-${i}`),
        workspaceKey: this.resolveWorkspaceKey(cwd),
      });
    });
  }

  private ingestActivity(activity: GitActivityRecord): void {
    this.store.ingest(activity);
  }

  private resolveWorkspaceKey(cwd: string | undefined): string {
    const identity = this.identityResolver.resolve(cwd);
    if (identity === null) {
      return UNATTRIBUTED_WORKSPACE_KEY;
    }
    // Use repoKey for repo-level identity and worktreeKey for worktree-level
    // tracking. For now, use worktreeKey so each worktree is tracked separately.
    return identity.worktreeKey;
  }

  // `discriminator` is part of the id, not just a label: one ToolCallRecord
  // can legitimately produce several distinct activities (e.g. `npm run
  // build && git commit` is both a 'verify' and a 'git' activity from the
  // SAME record, and a record can even be both isTestCommand AND
  // isBuildCommand at once). Without a discriminator in the id, two such
  // activities would share the same (workspaceKey, recordId) pair and the
  // store's insert-or-ignore dedup would silently drop the second one as a
  // "duplicate" of the first — so this takes a string specific enough to
  // distinguish every activity kind AND sub-kind a single record can
  // produce, not just `GitActivityRecord['kind']`.
  private makeRecordId(record: ToolCallRecord, discriminator: string): string {
    const base =
      record.toolUseId && record.toolUseId.length > 0
        ? record.toolUseId
        : `${record.sessionId ?? 'unknown'}:${record.timestamp}:${record.toolName}`;
    return `${base}:${discriminator}`;
  }
}
