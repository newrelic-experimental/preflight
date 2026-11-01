import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from './local-store.js';
import type { HookEvent } from './types.js';

const mockHooks: {
  rename: ((from: fs.PathLike, to: fs.PathLike) => void) | null;
  drainRead: ((path: string) => void) | null;
} = { rename: null, drainRead: null };

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
    readFileSync: ((path: fs.PathOrFileDescriptor, options?: unknown) => {
      const hook = mockHooks.drainRead;
      if (hook && String(path).includes('.drain')) {
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

function line(tool: string): string {
  return (
    JSON.stringify({ mode: 'post', tool, input: {}, timestamp: 1, session_id: SESSION }) + '\n'
  );
}

function tools(events: HookEvent[]): string[] {
  return events.map((e) => e.tool).sort();
}

function leftovers(): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith(`buffer-${SESSION}.jsonl`));
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
  mockHooks.drainRead = () => {
    throw new Error('drainer died after claiming the buffer');
  };
  asProcess(pid, () => new LocalStore(dir, SESSION).drainBuffer());
  mockHooks.drainRead = null;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = fs.mkdtempSync(resolve(tmpdir(), 'nr-drain-race-'));
  bufferPath = resolve(dir, `buffer-${SESSION}.jsonl`);
});

afterEach(() => {
  mockHooks.rename = null;
  mockHooks.drainRead = null;
  jest.restoreAllMocks();
  fs.chmodSync(dir, 0o700);
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

  it('recovers a legacy .drain left by an older version exactly once', () => {
    fs.writeFileSync(`${bufferPath}.drain`, line('Legacy'));
    fs.writeFileSync(bufferPath, line('Fresh'));

    const first = new LocalStore(dir, SESSION).drainBuffer();
    const second = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools(first)).toEqual(['Fresh', 'Legacy']);
    expect(second).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('returns recovered events only once when the unlink fails after the read', () => {
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(`${bufferPath}.drain`, line('A'));

    fs.chmodSync(dir, 0o500);
    const whileReadOnly = [
      ...new LocalStore(dir, SESSION).drainBuffer(),
      ...new LocalStore(dir, SESSION).drainBuffer(),
    ];
    fs.chmodSync(dir, 0o700);
    const afterRestart = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools([...whileReadOnly, ...afterRestart])).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });
});
