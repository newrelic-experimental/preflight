/**
 * Cross-platform ancestor-PID walk for the MCP server (read side).
 *
 * Why this exists: the session-id breadcrumb the hook collector writes is keyed
 * on a PID, and `resolveFromBreadcrumb()` (session-resolver.ts) looks it up at
 * the MCP server's own `process.ppid`. That only lines up when the server and
 * the collector are both direct children of the IDE. When the server's launch
 * command routes through a wrapper — `npx`, which execs an `npm exec` process
 * in between — the server's `ppid` is the wrapper, not the IDE, and the lookup
 * misses even though the correct breadcrumb is sitting one level further up.
 * Confirmed on Kiro: `Kiro Helper → npm exec → node preflight --stdio`, with
 * the breadcrumb at Kiro Helper's PID.
 *
 * Note this is NOT the same gap `collector-script.ts`'s `getLinuxAncestorPids`
 * covers. That one walks up from the *collector's* ppid so the collector can
 * write a breadcrumb at every ancestor, for hook runners that interpose a shell
 * between the IDE and the collector. A wrapper between the IDE and the *server*
 * is a different branch of the tree, so no amount of write-side walking reaches
 * it — the server has to walk its own ancestry.
 *
 * Platform coverage:
 *   - linux  — reads `/proc/<pid>/stat`. No subprocess.
 *   - darwin and other POSIX — one `ps -Ao pid=,ppid=` call for the whole
 *     process table, parsed into a pid→ppid map and walked in memory.
 *   - win32  — NOT IMPLEMENTED: returns `[startPid]`, which is exactly the
 *     pre-walk behavior, so nothing regresses. `wmic` is deprecated/removed on
 *     current Windows and PowerShell `Get-CimInstance` costs hundreds of ms to
 *     start, so neither was adopted blind. Consequence to be aware of: a
 *     wrapper-launched MCP server on native Windows still can't resolve its
 *     session_id by PID. Claude Code on native Windows is unaffected — it
 *     launches the server directly and has the cwd breadcrumb as a fallback.
 *
 * The `/proc` parsing here is deliberately duplicated from
 * `collector-script.ts`'s `getLinuxAncestorPids` rather than imported: that
 * module runs on every single tool call under a <5ms budget with a "no heavy
 * imports" rule, and importing this one would pull `node:child_process` into
 * that path. It also has top-level side effects (it reads stdin when invoked
 * directly). Same precedent as `src/metrics/transcript-reasoning.ts`'s
 * duplicated `translateWslPath`. Keep the two parsers in sync.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { createLogger } from '../shared/index.js';

const logger = createLogger('process-ancestry');

/** Whole-table lookup timeout. Matches the 2s budget used for `git` in index.ts. */
const PS_TIMEOUT_MS = 2000;

/**
 * Narrowed `execFileSync` shape — only what this module needs, so tests can
 * inject a plain function instead of mocking `node:child_process`. Mirrors
 * `ExecFileFn` in src/alerts/os-notifier.ts.
 */
export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: 'utf-8';
    readonly timeout: number;
    readonly stdio: readonly ['ignore', 'pipe', 'ignore'];
  },
) => string;

export interface AncestorPidsOptions {
  /** How many levels above `startPid` to walk. Default 4 — see getAncestorPids. */
  readonly maxDepth?: number;
  /** Override `process.platform` (test seam). */
  readonly platform?: NodeJS.Platform;
  /** Override the `ps` invocation (test seam). */
  readonly execFileSync?: ExecFileSyncFn;
}

/**
 * Seam for unit tests: replace `readFile` to inject fake `/proc/<pid>/stat`
 * content without touching the real filesystem. Production code never sets this.
 * @internal
 */
export const _procFs = {
  readFile: (path: string): string => readFileSync(path, 'utf-8'),
};

/**
 * Parses a `/proc/<pid>/stat` line and returns the parent PID, or null when the
 * line is malformed.
 *
 * Format: `pid (comm) state ppid pgrp ...`. `comm` can itself contain spaces
 * and parentheses, so the field separator is found with lastIndexOf(')').
 */
function parentPidFromProcStat(stat: string): number | null {
  const lastParen = stat.lastIndexOf(')');
  if (lastParen === -1) return null;
  // After the last ')': " state ppid ..." — split on space, index [1] is ppid.
  const parsed = parseInt(stat.slice(lastParen + 2).split(' ')[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Builds a pid→ppid map for every process, via a single `ps` call.
 * Returns an empty map on any failure (missing `ps`, non-zero exit, timeout,
 * unparseable output) so callers degrade to a depth-0 walk rather than throw.
 */
function readProcessTable(execFileSync: ExecFileSyncFn): Map<number, number> {
  const table = new Map<number, number>();
  let out: string;
  try {
    // `-A` = all processes; `-o pid=,ppid=` = those two columns, no header.
    // Both are POSIX options. One call for the whole table rather than one per
    // level, so the walk costs a single subprocess (~40ms on macOS).
    out = execFileSync('ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // execFileSync throws on non-zero exit, timeout, and ENOENT alike. A
    // pathological injected fn could also throw synchronously — same handling.
    logger.debug('Could not read process table via ps', { error: String(err) });
    return table;
  }
  if (typeof out !== 'string') return table;

  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0] ?? '', 10);
    const ppid = parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    table.set(pid, ppid);
  }
  return table;
}

/**
 * Returns `[startPid, parent, grandparent, ...]` — `startPid` is always at
 * index 0, so the result is never empty for a valid input.
 *
 * The walk stops at `maxDepth` levels, at PID <= 1 (init/systemd and the PID-0
 * sentinel are never useful breadcrumb keys), on a cycle, and on any lookup
 * failure. Default `maxDepth` is 4: the motivating `npx` case needs only one
 * level, and a wrapper shell behind it would need two, while deeper ancestors
 * are progressively more *shared* between concurrent sessions on the same
 * machine — so a shallow cap covers real launcher shapes without widening the
 * window for resolving to a neighbouring session's breadcrumb.
 *
 * Never throws.
 */
export function getAncestorPids(startPid: number, options: AncestorPidsOptions = {}): number[] {
  if (!Number.isFinite(startPid) || startPid <= 0) return [];

  const maxDepth = options.maxDepth ?? 4;
  const platform = options.platform ?? process.platform;
  const pids: number[] = [startPid];

  if (platform === 'win32') {
    // Not implemented — see the module doc comment. Returning just the direct
    // pid keeps behavior identical to having no walk at all.
    return pids;
  }

  // On Linux read /proc directly; everywhere else pay for one `ps` call, and
  // only lazily — a walk that stops at depth 0 never spawns anything.
  let table: Map<number, number> | undefined;
  const execFileSync = options.execFileSync ?? (nodeExecFileSync as unknown as ExecFileSyncFn);

  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    let parentPid: number | null = null;

    if (platform === 'linux') {
      try {
        parentPid = parentPidFromProcStat(_procFs.readFile(`/proc/${pid}/stat`));
      } catch {
        break;
      }
    } else {
      table ??= readProcessTable(execFileSync);
      parentPid = table.get(pid) ?? null;
    }

    if (parentPid === null || !Number.isFinite(parentPid) || parentPid <= 1) break;
    if (pids.includes(parentPid)) break; // cycle guard
    pids.push(parentPid);
    pid = parentPid;
  }

  return pids;
}
