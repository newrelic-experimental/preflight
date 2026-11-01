import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from './local-store.js';
import type { HookEvent } from './types.js';

const mockHooks: {
  rename: ((from: fs.PathLike, to: fs.PathLike) => void) | null;
  drainRead: ((path: string) => void) | null;
  listOrder: ((dir: string, names: string[]) => string[]) | null;
  reads: string[];
  listings: string[];
} = { rename: null, drainRead: null, listOrder: null, reads: [], listings: [] };

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof fs>('node:fs');
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      const hook = mockHooks.rename;
      if (!hook) return real.renameSync(from, to);
      mockHooks.rename = null;
      hook(from, to);
    },
    readdirSync: ((path: fs.PathLike, options?: unknown) => {
      mockHooks.listings.push(String(path));
      const names = (real.readdirSync as (p: fs.PathLike, o?: unknown) => string[])(path, options);
      return mockHooks.listOrder ? mockHooks.listOrder(String(path), names) : names;
    }) as typeof real.readdirSync,
    readFileSync: ((path: fs.PathOrFileDescriptor, options?: unknown) => {
      mockHooks.reads.push(String(path));
      const hook = mockHooks.drainRead;
      if (hook && /\.drain|[\\/]drains[\\/]/.test(String(path))) {
        mockHooks.drainRead = null;
        hook(String(path));
      }
      return (real.readFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(
        path,
        options,
      );
    }) as typeof real.readFileSync,
  };
});

const SESSION = 'drain-race-session';
const DEAD_PID = 2_147_483_000;
const OTHER_LIVE_PID = process.ppid;
const REAL_PID = process.pid;

let dir: string;
let bufferPath: string;
let stderr: jest.SpiedFunction<typeof console.error>;

function line(tool: string, mode: 'pre' | 'post' = 'post'): string {
  return JSON.stringify({ mode, tool, input: {}, timestamp: 1, session_id: SESSION }) + '\n';
}

function tools(events: HookEvent[]): string[] {
  return events.map((e) => `${e.tool}${e.mode === 'pre' ? ':pre' : ''}`);
}

function claimPaths(): string[] {
  return [dir, resolve(dir, 'drains')]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) =>
      fs
        .readdirSync(d)
        .filter((n) => n.startsWith(`buffer-${SESSION}.jsonl.`))
        .map((n) => resolve(d, n)),
    );
}

function leftovers(): string[] {
  return [...claimPaths(), ...(fs.existsSync(bufferPath) ? [bufferPath] : [])];
}

function later(ms: number): void {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + ms);
}

function warnings(): unknown[] {
  return stderr.mock.calls
    .map((args: unknown[]) => JSON.parse(String(args[0])) as { level?: string })
    .filter((entry: { level?: string }) => entry.level === 'warn');
}

function setPid(pid: number): void {
  Object.defineProperty(process, 'pid', { value: pid, configurable: true, enumerable: true });
}

function asProcess<T>(pid: number, run: () => T): T {
  setPid(pid);
  try {
    return run();
  } finally {
    setPid(REAL_PID);
  }
}

function crashMidDrain(pid: number): void {
  const crash = (): void => {
    mockHooks.drainRead = crash;
    throw new Error('drainer died after claiming the buffer');
  };
  mockHooks.drainRead = crash;
  asProcess(pid, () => new LocalStore(dir, SESSION).drainBuffer());
  mockHooks.drainRead = null;
}

beforeEach(() => {
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockHooks.reads = [];
  mockHooks.listings = [];
  dir = fs.mkdtempSync(resolve(tmpdir(), 'nr-drain-race-'));
  bufferPath = resolve(dir, `buffer-${SESSION}.jsonl`);
});

afterEach(() => {
  mockHooks.rename = null;
  mockHooks.drainRead = null;
  mockHooks.listOrder = null;
  jest.restoreAllMocks();
  for (const d of [dir, resolve(dir, 'drains')]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('concurrent drainers of one buffer', () => {
  it('loses nothing when D2 renames after D1 claimed the buffer and a hook appended', () => {
    fs.writeFileSync(bufferPath, line('A') + line('B'));
    const d1 = new LocalStore(dir, SESSION);
    const d2 = new LocalStore(dir, SESSION);
    let d1Got: HookEvent[] = [];

    mockHooks.rename = (d2From, d2To) => {
      mockHooks.drainRead = () => {
        fs.appendFileSync(bufferPath, line('C'));
        fs.renameSync(d2From, d2To);
      };
      d1Got = asProcess(OTHER_LIVE_PID, () => d1.drainBuffer());
    };
    const d2Got = d2.drainBuffer();

    expect(tools([...d1Got, ...d2Got])).toEqual(['A', 'B', 'C']);
    expect(leftovers()).toEqual([]);
  });

  it("does not steal a live process's in-flight drain", () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(OTHER_LIVE_PID);

    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);
    expect(leftovers()).toHaveLength(1);

    const owner = asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer());
    expect(tools(owner)).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it("recovers a dead process's drain exactly once", () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);

    const first = new LocalStore(dir, SESSION).drainBuffer();
    const second = asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer());

    expect(tools([...first, ...second])).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it("drainAllBuffers recovers a dead process's drain when no buffer is left", () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    expect(fs.existsSync(bufferPath)).toBe(false);

    const all = new LocalStore(dir).drainAllBuffers();

    expect(tools(all)).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it('drainAllBuffers leaves the buffer to an owner that appears mid-drain', () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    fs.writeFileSync(bufferPath, line('B'));

    mockHooks.rename = (from, to) => {
      fs.writeFileSync(resolve(dir, `active-${SESSION}.pid`), String(OTHER_LIVE_PID));
      fs.renameSync(from, to);
    };
    const all = new LocalStore(dir).drainAllBuffers();
    const owner = asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer());

    expect(tools(all)).toEqual(['A']);
    expect(tools(owner)).toEqual(['B']);
    expect(leftovers()).toEqual([]);
  });

  it('recovers an abandoned legacy .drain left by an older version exactly once', () => {
    fs.writeFileSync(`${bufferPath}.drain`, line('Legacy'));
    fs.writeFileSync(bufferPath, line('Fresh'));
    later(61_000);

    const first = new LocalStore(dir, SESSION).drainBuffer();
    const second = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools(first)).toEqual(['Legacy', 'Fresh']);
    expect(second).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('leaves a fresh legacy .drain to the older version that may be recovering it', () => {
    const legacy = `${bufferPath}.drain`;
    fs.writeFileSync(legacy, line('Legacy'));

    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);
    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);

    later(61_000);
    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['Legacy']);
    expect(leftovers()).toEqual([]);
  });

  it('adopts a claim whose pid looks alive once it is older than any drain', () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(OTHER_LIVE_PID);
    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);

    later(11 * 60_000);
    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it('returns recovered claims in write order, so a Post never comes before its Pre', () => {
    fs.writeFileSync(bufferPath, line('A', 'pre'));
    crashMidDrain(DEAD_PID);
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID - 1);
    const now = Date.now() / 1000;
    for (const path of claimPaths()) {
      const age = fs.readFileSync(path, 'utf-8').includes('"pre"') ? 20 : 10;
      fs.utimesSync(path, now - age, now - age);
    }
    fs.writeFileSync(bufferPath, line('B'));
    const mtime = (d: string, n: string): number => {
      try {
        return fs.statSync(resolve(d, n)).mtimeMs;
      } catch {
        return 0;
      }
    };
    mockHooks.listOrder = (d, names) => [...names].sort((a, b) => mtime(d, b) - mtime(d, a));

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['A:pre', 'A', 'B']);
    expect(leftovers()).toEqual([]);
  });

  it('drainBuffer polls without listing the storage directory', () => {
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(resolve(dir, `buffer-other-${i}.jsonl`), line('Other'));
    }
    const store = new LocalStore(dir, SESSION);
    fs.writeFileSync(bufferPath, line('A'));
    mockHooks.listings = [];

    expect(tools(store.drainBuffer())).toEqual(['A']);
    expect(store.drainBuffer()).toEqual([]);
    expect(mockHooks.listings).not.toContain(dir);

    new LocalStore(dir).drainAllBuffers();
    expect(mockHooks.listings.filter((p) => p === dir)).toHaveLength(1);
  });

  it('drainAllBuffers reads an owner heartbeat once per buffer when there is nothing to adopt', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const heartbeat = resolve(dir, `active-${SESSION}.pid`);
    fs.writeFileSync(heartbeat, String(DEAD_PID));
    mockHooks.reads = [];

    expect(tools(new LocalStore(dir).drainAllBuffers())).toEqual(['A']);
    expect(mockHooks.reads.filter((p) => p === heartbeat)).toHaveLength(1);
  });

  it('warns once when it cannot list the drain claims, and recovers once it can', () => {
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    stderr.mockClear();
    const dirs = [dir, resolve(dir, 'drains')].filter((d) => fs.existsSync(d));
    for (const d of dirs) fs.chmodSync(d, 0o300);

    const store = new LocalStore(dir, SESSION);
    expect([...store.drainBuffer(), ...store.drainBuffer()]).toEqual([]);
    expect(warnings()).toHaveLength(1);

    for (const d of dirs) fs.chmodSync(d, 0o700);
    expect(tools(store.drainBuffer())).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it('peekAllBuffers counts lines held in drain claims', () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(OTHER_LIVE_PID);
    fs.writeFileSync(`${bufferPath}.drain`, line('Legacy'));
    fs.writeFileSync(bufferPath, line('B'));

    expect(tools(new LocalStore(dir).peekAllBuffers()).sort()).toEqual(['A', 'B', 'Legacy']);
    expect(leftovers()).toHaveLength(3);
  });

  it('returns recovered events only once when the unlink fails after the read', () => {
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(REAL_PID);
    const claimDir = resolve(claimPaths()[0]!, '..');

    fs.chmodSync(claimDir, 0o500);
    const whileReadOnly = [
      ...new LocalStore(dir, SESSION).drainBuffer(),
      ...new LocalStore(dir, SESSION).drainBuffer(),
    ];
    fs.chmodSync(claimDir, 0o700);
    const afterRestart = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools([...whileReadOnly, ...afterRestart])).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });
});
