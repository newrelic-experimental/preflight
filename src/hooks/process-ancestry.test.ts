import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { getAncestorPids, _procFs, type ExecFileSyncFn } from './process-ancestry.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let originalReadFile: typeof _procFs.readFile;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  originalReadFile = _procFs.readFile;
});

afterEach(() => {
  stderrSpy.mockRestore();
  _procFs.readFile = originalReadFile;
});

/**
 * Fake `/proc/<pid>/stat` reads. An unmapped /proc path throws ENOENT, which is
 * how the walk sees "no such process" / a non-Linux box.
 */
function mockProc(statMap: Record<string, string>): void {
  _procFs.readFile = (path: string): string => {
    if (path in statMap) return statMap[path]!;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
}

/** `ps -Ao pid=,ppid=`-shaped output from a pid→ppid map. */
function psOutput(pairs: ReadonlyArray<readonly [number, number]>): string {
  return pairs.map(([pid, ppid]) => `  ${pid}   ${ppid}`).join('\n') + '\n';
}

function makeExec(output: string): { fn: ExecFileSyncFn; calls: number } {
  const state = { fn: (() => '') as ExecFileSyncFn, calls: 0 };
  state.fn = ((_file, _args, _opts) => {
    state.calls++;
    return output;
  }) as ExecFileSyncFn;
  return state as { fn: ExecFileSyncFn; calls: number };
}

describe('process-ancestry', () => {
  describe('getAncestorPids() — input guards', () => {
    it('returns an empty array for a non-positive or non-finite startPid', () => {
      expect(getAncestorPids(0, { platform: 'linux' })).toEqual([]);
      expect(getAncestorPids(-5, { platform: 'linux' })).toEqual([]);
      expect(getAncestorPids(Number.NaN, { platform: 'linux' })).toEqual([]);
      expect(getAncestorPids(Number.POSITIVE_INFINITY, { platform: 'linux' })).toEqual([]);
    });

    it('always includes startPid at index 0', () => {
      mockProc({});
      expect(getAncestorPids(1001, { platform: 'linux' })[0]).toBe(1001);
    });
  });

  describe('getAncestorPids() — linux (/proc)', () => {
    it('returns just startPid when /proc is unreadable', () => {
      mockProc({});
      expect(getAncestorPids(1001, { platform: 'linux' })).toEqual([1001]);
    });

    it('walks through one interposed process', () => {
      mockProc({ '/proc/1001/stat': '1001 (npm exec) S 1000 1001 1000 0 -1 0' });
      expect(getAncestorPids(1001, { platform: 'linux' })).toEqual([1001, 1000]);
    });

    it('parses a comm field containing spaces and parentheses', () => {
      mockProc({ '/proc/2000/stat': '2000 (my(app) name) S 1999 2000 2000 0 -1 0' });
      expect(getAncestorPids(2000, { platform: 'linux' })).toEqual([2000, 1999]);
    });

    it('stops before PID 1 (init/systemd is not a useful breadcrumb key)', () => {
      mockProc({ '/proc/100/stat': '100 (daemon) S 1 100 100 0 -1 0' });
      expect(getAncestorPids(100, { platform: 'linux' })).toEqual([100]);
    });

    it('stops at a PID 0 sentinel', () => {
      mockProc({ '/proc/50/stat': '50 (kthread) S 0 0 0 0 -1 0' });
      expect(getAncestorPids(50, { platform: 'linux' })).toEqual([50]);
    });

    it('respects the default maxDepth of 4', () => {
      const statMap: Record<string, string> = {};
      for (let pid = 100; pid > 80; pid--) {
        statMap[`/proc/${pid}/stat`] = `${pid} (proc) S ${pid - 1} ${pid} ${pid} 0 -1 0`;
      }
      mockProc(statMap);
      // startPid + 4 ancestors
      expect(getAncestorPids(100, { platform: 'linux' })).toEqual([100, 99, 98, 97, 96]);
    });

    it('respects an explicit maxDepth', () => {
      const statMap: Record<string, string> = {};
      for (let pid = 100; pid > 80; pid--) {
        statMap[`/proc/${pid}/stat`] = `${pid} (proc) S ${pid - 1} ${pid} ${pid} 0 -1 0`;
      }
      mockProc(statMap);
      expect(getAncestorPids(100, { platform: 'linux', maxDepth: 2 })).toEqual([100, 99, 98]);
      expect(getAncestorPids(100, { platform: 'linux', maxDepth: 0 })).toEqual([100]);
    });

    it('breaks on a cycle rather than looping forever', () => {
      mockProc({
        '/proc/100/stat': '100 (a) S 99 100 100 0 -1 0',
        '/proc/99/stat': '99 (b) S 100 99 99 0 -1 0',
      });
      expect(getAncestorPids(100, { platform: 'linux' })).toEqual([100, 99]);
    });

    it('stops on a stat line with no closing paren', () => {
      mockProc({ '/proc/300/stat': '300 malformed-no-parens' });
      expect(getAncestorPids(300, { platform: 'linux' })).toEqual([300]);
    });

    it('stops when the parsed ppid is not a number', () => {
      mockProc({ '/proc/400/stat': '400 (proc) S notanumber 400 400 0 -1 0' });
      expect(getAncestorPids(400, { platform: 'linux' })).toEqual([400]);
    });

    it('never spawns a subprocess on linux', () => {
      mockProc({ '/proc/1001/stat': '1001 (sh) S 1000 1001 1000 0 -1 0' });
      const exec = makeExec('');
      getAncestorPids(1001, { platform: 'linux', execFileSync: exec.fn });
      expect(exec.calls).toBe(0);
    });
  });

  describe('getAncestorPids() — darwin (ps)', () => {
    it('walks the npx-shaped tree from the real Kiro trace', () => {
      // Kiro Helper 72451 -> npm exec 72995 -> node preflight --stdio 73033.
      // The server starts the walk at its own ppid (the npm exec wrapper).
      const exec = makeExec(
        psOutput([
          [73033, 72995],
          [72995, 72451],
          [72451, 72060],
          [72060, 1],
        ]),
      );
      expect(getAncestorPids(72995, { platform: 'darwin', execFileSync: exec.fn })).toEqual([
        72995, 72451, 72060,
      ]);
    });

    it('reads the process table exactly once, not once per level', () => {
      const exec = makeExec(
        psOutput([
          [100, 99],
          [99, 98],
          [98, 97],
          [97, 1],
        ]),
      );
      getAncestorPids(100, { platform: 'darwin', execFileSync: exec.fn });
      expect(exec.calls).toBe(1);
    });

    it('returns just startPid when the pid is absent from the table', () => {
      const exec = makeExec(psOutput([[555, 1]]));
      expect(getAncestorPids(999, { platform: 'darwin', execFileSync: exec.fn })).toEqual([999]);
    });

    it('returns just startPid when ps output is empty or unparseable', () => {
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: makeExec('').fn })).toEqual([
        100,
      ]);
      expect(
        getAncestorPids(100, { platform: 'darwin', execFileSync: makeExec('garbage\nlines').fn }),
      ).toEqual([100]);
    });

    it('returns just startPid when ps throws (missing binary, timeout, non-zero exit)', () => {
      const throwing = (() => {
        throw Object.assign(new Error('ENOENT: ps'), { code: 'ENOENT' });
      }) as ExecFileSyncFn;
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: throwing })).toEqual([100]);
    });

    it('tolerates ps returning a non-string', () => {
      const weird = (() => undefined as unknown as string) as ExecFileSyncFn;
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: weird })).toEqual([100]);
    });

    it('applies the same depth cap as the linux path', () => {
      const exec = makeExec(
        psOutput([
          [100, 99],
          [99, 98],
          [98, 97],
          [97, 96],
          [96, 95],
          [95, 94],
        ]),
      );
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: exec.fn })).toEqual([
        100, 99, 98, 97, 96,
      ]);
    });

    it('breaks on a cycle in the ps table', () => {
      const exec = makeExec(
        psOutput([
          [100, 99],
          [99, 100],
        ]),
      );
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: exec.fn })).toEqual([
        100, 99,
      ]);
    });

    it('stops before PID 1', () => {
      const exec = makeExec(
        psOutput([
          [100, 1],
          [1, 0],
        ]),
      );
      expect(getAncestorPids(100, { platform: 'darwin', execFileSync: exec.fn })).toEqual([100]);
    });
  });

  describe('getAncestorPids() — win32 (not implemented)', () => {
    it('returns just startPid and never spawns anything', () => {
      const exec = makeExec(
        psOutput([
          [100, 99],
          [99, 98],
        ]),
      );
      expect(getAncestorPids(100, { platform: 'win32', execFileSync: exec.fn })).toEqual([100]);
      expect(exec.calls).toBe(0);
    });
  });
});
