import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendToHookBuffer, DRAIN_SEAL as SEAL } from './hook-buffer.js';
import { LocalStore } from './local-store.js';
import { formatClaimName } from './drain-claims.js';
import { HookEventProcessor } from '../hooks/event-processor.js';
import type { HookEvent, ToolCallRecord } from './types.js';

const mockHooks: {
  rename: ((from: fs.PathLike, to: fs.PathLike) => void) | null;
  drainRead: ((path: string) => void) | null;
  opened: ((path: string) => void) | null;
  write: ((text: string) => void) | null;
  shortWrite: ((text: string) => number | null) | null;
  unlink: ((path: string) => void) | null;
  listOrder: ((dir: string, names: string[]) => string[]) | null;
  nonce: ((size: number) => Buffer) | null;
} = {
  rename: null,
  drainRead: null,
  opened: null,
  write: null,
  shortWrite: null,
  unlink: null,
  listOrder: null,
  nonce: null,
};

function textOf(data: unknown): string {
  return typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf-8');
}

const DRAIN_PATH_RE = /\.drain|[\\/]drains[\\/]/;

function onDrainRead(path: string): void {
  const hook = mockHooks.drainRead;
  if (hook && DRAIN_PATH_RE.test(path)) {
    mockHooks.drainRead = null;
    hook(path);
  }
}

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
    openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      onDrainRead(String(path));
      const fd = real.openSync(path, flags, mode);
      mockHooks.opened?.(String(path));
      return fd;
    }) as typeof real.openSync,
    writeSync: ((fd: number, data: unknown, ...rest: unknown[]) => {
      const text = textOf(data);
      mockHooks.write?.(text);
      const short = mockHooks.shortWrite?.(text);
      if (short !== null && short !== undefined) {
        mockHooks.shortWrite = null;
        return real.writeSync(fd, Buffer.from(text).subarray(0, short));
      }
      return (real.writeSync as (fd: number, data: unknown, ...rest: unknown[]) => number)(
        fd,
        data,
        ...rest,
      );
    }) as typeof real.writeSync,
    unlinkSync: (path: fs.PathLike) => {
      const hook = mockHooks.unlink;
      mockHooks.unlink = null;
      hook?.(String(path));
      real.unlinkSync(path);
    },
    readdirSync: ((path: fs.PathLike, options?: unknown) => {
      const names = (real.readdirSync as (p: fs.PathLike, o?: unknown) => string[])(path, options);
      return mockHooks.listOrder ? mockHooks.listOrder(String(path), names) : names;
    }) as typeof real.readdirSync,
    readFileSync: ((path: fs.PathOrFileDescriptor, options?: unknown) => {
      onDrainRead(String(path));
      return (real.readFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => string | Buffer)(
        path,
        options,
      );
    }) as typeof real.readFileSync,
  };
});

jest.mock('node:crypto', () => {
  const real = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...real,
    randomBytes: (size: number) => mockHooks.nonce?.(size) ?? real.randomBytes(size),
  };
});

const SESSION = 'drain-race-session';
const DEAD_PID = 2_147_483_000;
const OTHER_LIVE_PID = process.ppid;
const REAL_PID = process.pid;

let dir: string;
let bufferPath: string;
let stderr: jest.SpiedFunction<typeof console.error>;

function line(tool: string, mode: 'pre' | 'post' = 'post', sessionId = SESSION): string {
  return JSON.stringify({ mode, tool, input: {}, timestamp: 1, sessionId }) + '\n';
}

function drainsDir(): string {
  return resolve(dir, 'drains');
}

function writeClaim(pid: number, claimedAt: number, content: string, session = SESSION): string {
  fs.mkdirSync(drainsDir(), { recursive: true });
  const path = resolve(drainsDir(), formatClaimName(`buffer-${session}.jsonl`, pid, claimedAt));
  fs.writeFileSync(path, content);
  return path;
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

function failing(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

function refuseUnlinkOf(...tools: string[]): void {
  const refuse = (path: string): void => {
    mockHooks.unlink = refuse;
    const text = fs.readFileSync(path, 'utf-8');
    if (tools.some((tool) => text.includes(`"tool":"${tool}"`))) throw failing('EPERM');
  };
  mockHooks.unlink = refuse;
}

function refuseAdoptionOf(claim: string, times: number): void {
  const real = jest.requireActual<typeof fs>('node:fs');
  let refusals = 0;
  const refuse = (from: fs.PathLike, to: fs.PathLike): void => {
    mockHooks.rename = refuse;
    if (String(from) === claim && refusals++ < times) throw failing('EPERM');
    real.renameSync(from, to);
  };
  mockHooks.rename = refuse;
}

function gaveUpWarnings(): unknown[] {
  return warnings().filter((entry) =>
    String((entry as { message?: string }).message).startsWith('Gave up holding hook events'),
  );
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

function crashMidDrain(pid: number, session = SESSION): void {
  const crash = (): void => {
    mockHooks.drainRead = crash;
    throw new Error('drainer died after claiming the buffer');
  };
  mockHooks.drainRead = crash;
  asProcess(pid, () => new LocalStore(dir, session).drainBuffer());
  mockHooks.drainRead = null;
}

beforeEach(() => {
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = fs.mkdtempSync(resolve(tmpdir(), 'nr-drain-race-'));
  bufferPath = resolve(dir, `buffer-${SESSION}.jsonl`);
});

afterEach(() => {
  mockHooks.rename = null;
  mockHooks.drainRead = null;
  mockHooks.opened = null;
  mockHooks.write = null;
  mockHooks.shortWrite = null;
  mockHooks.unlink = null;
  mockHooks.listOrder = null;
  mockHooks.nonce = null;
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

    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);
    later(61_000);
    const first = new LocalStore(dir, SESSION).drainBuffer();
    const second = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools(first)).toEqual(['Legacy', 'Fresh']);
    expect(second).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('stops holding the buffer for a legacy .drain once it has been watched for a minute', () => {
    const legacy = `${bufferPath}.drain`;
    fs.writeFileSync(legacy, line('Legacy'));
    fs.writeFileSync(bufferPath, line('Fresh'));
    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);

    later(61_000);
    fs.appendFileSync(legacy, line('Legacy2'));

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['Fresh']);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('adopts a legacy .drain only after watching it for a minute, whatever its file times', () => {
    const legacy = `${bufferPath}.drain`;
    fs.writeFileSync(legacy, line('Legacy'));
    later(61_000);

    expect(new LocalStore(dir, SESSION).drainBuffer()).toEqual([]);
    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);

    later(61_000);
    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['Legacy']);
    expect(leftovers()).toEqual([]);
  });

  it('watches a legacy .drain again when an older version changes it', () => {
    const legacy = `${bufferPath}.drain`;
    fs.writeFileSync(legacy, line('L1'));
    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);

    later(61_000);
    fs.appendFileSync(legacy, line('L2'));
    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);

    later(61_000);
    expect(tools(new LocalStore(dir).drainAllBuffers())).toEqual(['L1', 'L2']);
  });

  it('adopts a live pid claim once its name says it is older than any drain, whatever its file times', () => {
    const now = Date.now();
    writeClaim(OTHER_LIVE_PID, now, line('Fresh'));
    writeClaim(OTHER_LIVE_PID, now - 11 * 60_000, line('Stale'));

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['Stale']);
    const [left, ...rest] = fs.readdirSync(drainsDir());
    expect(rest).toEqual([]);
    expect(left).toMatch(new RegExp(`^buffer-${SESSION}\\.jsonl\\.${OTHER_LIVE_PID}\\.${now}\\.`));
  });

  it('returns claims in the order their names say they were claimed, the fresh buffer last', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 10_000, line('A'));
    writeClaim(DEAD_PID - 1, now - 20_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B'));
    mockHooks.listOrder = (_d, names) => [...names].sort().reverse();

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['A:pre', 'A', 'B']);
    expect(leftovers()).toEqual([]);
  });

  it('returns an adopted claim before the fresh buffer after a late append reached it', () => {
    fs.writeFileSync(bufferPath, line('A', 'pre'));
    crashMidDrain(DEAD_PID);
    fs.writeFileSync(bufferPath, line('B'));
    const [claim] = fs.readdirSync(drainsDir()).map((n) => resolve(drainsDir(), n));
    fs.appendFileSync(claim!, line('A'));

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['A:pre', 'A', 'B']);
    expect(leftovers()).toEqual([]);
  });

  it('returns nothing after a claim it cannot unlink, so a post never precedes its pre', () => {
    writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B', 'pre') + line('A'));
    mockHooks.unlink = () => {
      throw failing('EPERM');
    };

    const store = new LocalStore(dir, SESSION);
    const firstPoll = store.drainBuffer();
    const secondPoll = store.drainBuffer();

    expect(tools(firstPoll)).toEqual([]);
    expect(tools(secondPoll)).toEqual(['A:pre', 'B:pre', 'A']);
    expect(leftovers()).toEqual([]);
  });

  it('holds the claims behind a claim it cannot unlink for 50 polls, then warns once and returns them', () => {
    writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    writeClaim(DEAD_PID, Date.now() - 5_000, line('B', 'pre'));
    refuseUnlinkOf('A');
    const store = new LocalStore(dir, SESSION);

    for (let poll = 1; poll <= 50; poll++) expect(store.drainBuffer()).toEqual([]);
    expect(gaveUpWarnings()).toEqual([]);

    expect(tools(store.drainBuffer())).toEqual(['B:pre']);
    for (let poll = 1; poll <= 5; poll++) expect(store.drainBuffer()).toEqual([]);
    const [stuck] = claimPaths();
    expect(gaveUpWarnings()).toEqual([expect.objectContaining({ claim: stuck })]);
  });

  it('holds the claims behind each of several stuck claims for 50 polls in turn', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 30_000, line('S1', 'pre'));
    writeClaim(DEAD_PID, now - 29_000, line('S2', 'pre'));
    writeClaim(DEAD_PID, now - 28_000, line('S3', 'pre'));
    writeClaim(DEAD_PID, now - 10_000, line('B', 'pre'));
    refuseUnlinkOf('S1', 'S2', 'S3');
    const store = new LocalStore(dir, SESSION);

    for (let poll = 1; poll <= 150; poll++) expect(store.drainBuffer()).toEqual([]);

    expect(tools(store.drainBuffer())).toEqual(['B:pre']);
    expect(gaveUpWarnings()).toHaveLength(3);
  });

  it('holds a claim that first fails on the poll that gives up another, so its post waits', () => {
    writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B', 'pre'));
    let preFailures = 0;
    const refuse = (path: string): void => {
      mockHooks.unlink = refuse;
      const text = fs.readFileSync(path, 'utf-8');
      if (text.includes('"tool":"A"')) throw failing('EPERM');
      if (text.includes('"mode":"pre","tool":"B"') && preFailures++ < 3) throw failing('EPERM');
    };
    mockHooks.unlink = refuse;
    const store = new LocalStore(dir, SESSION);

    for (let poll = 1; poll <= 51; poll++) expect(store.drainBuffer()).toEqual([]);
    fs.appendFileSync(bufferPath, line('B'));
    const returned: string[] = [];
    for (let poll = 1; poll <= 5; poll++) returned.push(...tools(store.drainBuffer()));

    expect(returned).toEqual(['B:pre', 'B']);
  });

  it('gives a stuck claim the full 50 polls after an earlier hold ended with its buffer unlisted', () => {
    const first = writeClaim(REAL_PID, Date.now() - 10_000, line('A', 'pre'));
    refuseUnlinkOf('A', 'C');
    const store = new LocalStore(dir);
    for (let poll = 1; poll <= 30; poll++) expect(store.drainAllBuffers()).toEqual([]);
    fs.rmSync(first);
    expect(store.drainAllBuffers()).toEqual([]);

    const now = Date.now();
    writeClaim(REAL_PID, now - 2_000, line('C', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('D', 'pre'));
    for (let poll = 1; poll <= 50; poll++) expect(store.drainAllBuffers()).toEqual([]);

    expect(tools(store.drainAllBuffers())).toEqual(['D:pre']);
  });

  it('claims no new buffer while a claim it cannot unlink holds the drain', () => {
    writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    refuseUnlinkOf('A');
    const store = new LocalStore(dir, SESSION);

    for (let poll = 1; poll <= 10; poll++) {
      fs.appendFileSync(bufferPath, line(`B${poll}`, 'pre'));
      expect(store.drainBuffer()).toEqual([]);
    }

    expect(claimPaths()).toHaveLength(1);
  });

  it('keeps a legacy .drain it took over ahead of a buffer claimed in the same millisecond', () => {
    fs.writeFileSync(`${bufferPath}.drain`, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('A'));
    const store = new LocalStore(dir, SESSION);
    expect(store.drainBuffer()).toEqual([]);
    later(61_000);
    const nonces = [0xff, 0x00];
    mockHooks.nonce = (size) => Buffer.alloc(size, nonces.shift() ?? 0x80);
    mockHooks.unlink = () => {
      throw failing('EPERM');
    };

    const polls = [store.drainBuffer(), store.drainBuffer()];

    expect(tools(polls.flat())).toEqual(['A:pre', 'A']);
    expect(leftovers()).toEqual([]);
  });

  it('does not let a second live drainer take over a claim it holds in order', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 20 * 60_000, line('A', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('B', 'pre') + line('A'));
    mockHooks.unlink = () => {
      throw failing('EPERM');
    };
    const store = new LocalStore(dir, SESSION);

    expect(store.drainBuffer()).toEqual([]);
    expect(asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer())).toEqual([]);

    expect(tools(store.drainBuffer())).toEqual(['A:pre', 'B:pre', 'A']);
    expect(leftovers()).toEqual([]);
  });

  it('returns the claims behind a stuck claim when two live drainers both see it', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 20 * 60_000, line('A', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('B', 'pre'));
    writeClaim(OTHER_LIVE_PID, now - 1_000, line('C', 'pre'));
    refuseUnlinkOf('A');
    const mine = new LocalStore(dir, SESSION);
    const theirs = new LocalStore(dir, SESSION);
    const returned: string[] = [];

    for (let poll = 1; poll <= 60; poll++) {
      returned.push(...tools(mine.drainBuffer()));
      returned.push(...tools(asProcess(OTHER_LIVE_PID, () => theirs.drainBuffer())));
    }

    expect(returned.sort()).toEqual(['B:pre', 'C:pre']);
  });

  it('takes every claim it can on the final drain, so stop() pairs each post once', () => {
    const records: ToolCallRecord[] = [];
    const store = new LocalStore(dir, SESSION);
    const processor = new HookEventProcessor({
      store,
      pollIntervalMs: 3_600_000,
      onRecord: (record) => records.push(record),
    });
    fs.writeFileSync(bufferPath, line('A', 'pre'));
    processor.processEvents(store.drainBuffer());
    const now = Date.now();
    writeClaim(REAL_PID, now - 2_000, line('X', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('A'));
    refuseUnlinkOf('X');

    processor.start();
    processor.stop();

    expect(records.map((r) => `${r.toolName}:${r.success ? 'paired' : r.errorType}`)).toEqual([
      'A:paired',
    ]);
  });

  it('holds the claims behind a stuck claim through replaceStore, so the call counts once', () => {
    const records: ToolCallRecord[] = [];
    const processor = new HookEventProcessor({
      store: new LocalStore(dir, SESSION),
      pollIntervalMs: 3_600_000,
      onRecord: (record) => records.push(record),
    });
    const now = Date.now();
    const stuck = writeClaim(REAL_PID, now - 2_000, line('A', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('A'));
    const refuse = (path: string): void => {
      mockHooks.unlink = refuse;
      if (path === stuck) throw failing('EPERM');
    };
    mockHooks.unlink = refuse;

    processor.start();
    processor.replaceStore(new LocalStore(dir, SESSION), false);
    mockHooks.unlink = null;
    processor.stop();

    expect(records.map((r) => `${r.toolName}:${r.success ? 'paired' : r.errorType}`)).toEqual([
      'A:paired',
    ]);
    expect(gaveUpWarnings()).toEqual([]);
  });

  it('keeps a pending pre through replaceStore while its post waits behind a stuck claim', () => {
    const records: ToolCallRecord[] = [];
    const store = new LocalStore(dir, SESSION);
    const processor = new HookEventProcessor({
      store,
      pollIntervalMs: 3_600_000,
      onRecord: (record) => records.push(record),
    });
    fs.writeFileSync(bufferPath, line('A', 'pre'));
    processor.processEvents(store.drainBuffer());
    const now = Date.now();
    writeClaim(REAL_PID, now - 2_000, line('X', 'pre'));
    writeClaim(REAL_PID, now - 1_000, line('A'));
    refuseUnlinkOf('X');

    processor.start();
    processor.replaceStore(new LocalStore(dir, SESSION), false);
    mockHooks.unlink = null;
    processor.stop();

    expect(records.map((r) => `${r.toolName}:${r.success ? 'paired' : r.errorType}`)).toEqual([
      'A:paired',
      'X:timeout',
    ]);
  });

  it("counts another session's call once when its post waits behind a stuck claim at the swap", () => {
    const outcomes = new Map<string, string>();
    const outcome = (r: ToolCallRecord): void => {
      outcomes.set(r.id, `${r.sessionId}:${r.toolName}:${r.success ? 'paired' : r.errorType}`);
    };
    const pending = new LocalStore(dir);
    const processor = new HookEventProcessor({
      store: pending,
      drainAllSessions: true,
      pollIntervalMs: 3_600_000,
      onRecord: outcome,
      onRecordAmend: outcome,
    });
    appendToHookBuffer(resolve(dir, 'buffer-other.jsonl'), line('A', 'pre', 'other'));
    processor.processEvents(pending.drainAllBuffers());
    const now = Date.now();
    writeClaim(REAL_PID, now - 2_000, line('X', 'pre', 'other'), 'other');
    writeClaim(REAL_PID, now - 1_000, line('A', 'post', 'other'), 'other');
    refuseUnlinkOf('X');

    processor.start();
    processor.replaceStore(new LocalStore(dir, SESSION), false);
    const atSwap = [...outcomes.values()];
    mockHooks.unlink = null;
    processor.stop();

    expect(atSwap).toEqual(['other:A:timeout']);
    expect([...outcomes.values()]).toEqual(['other:A:paired', 'other:X:timeout']);
  });

  it('keeps two adopted claims oldest first when the first take fails', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 20_000, line('A', 'pre'));
    writeClaim(DEAD_PID, now - 10_000, line('B', 'pre') + line('B'));
    mockHooks.listOrder = (_d, names) => [...names].sort().reverse();
    mockHooks.unlink = () => {
      throw failing('EPERM');
    };
    let clock = now;
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 5));

    const store = new LocalStore(dir, SESSION);
    const polls = [store.drainBuffer(), store.drainBuffer()];

    expect(tools(polls.flat())).toEqual(['A:pre', 'B:pre', 'B']);
    expect(leftovers()).toEqual([]);
  });

  it('returns nothing after a claim it cannot adopt, so a post never precedes its pre', () => {
    const claim = writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B', 'pre') + line('A'));
    refuseAdoptionOf(claim, 1);

    const store = new LocalStore(dir, SESSION);
    const firstPoll = store.drainBuffer();
    const secondPoll = store.drainBuffer();

    expect(tools(firstPoll)).toEqual([]);
    expect(tools(secondPoll)).toEqual(['A:pre', 'B:pre', 'A']);
    expect(leftovers()).toEqual([]);
  });

  it('takes the claims older than one it cannot adopt and holds the rest', () => {
    const now = Date.now();
    writeClaim(DEAD_PID, now - 20_000, line('A', 'pre'));
    const stuck = writeClaim(DEAD_PID - 1, now - 10_000, line('B', 'pre'));
    writeClaim(DEAD_PID - 2, now - 5_000, line('C', 'pre'));
    fs.writeFileSync(bufferPath, line('B'));
    refuseAdoptionOf(stuck, 1);

    const store = new LocalStore(dir, SESSION);

    expect(tools(store.drainBuffer())).toEqual(['A:pre']);
    expect(tools(store.drainBuffer())).toEqual(['B:pre', 'C:pre', 'B']);
    expect(leftovers()).toEqual([]);
  });

  it('holds the buffer behind a claim it cannot adopt for 50 polls, then warns once and drains it', () => {
    const claim = writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B', 'pre'));
    refuseAdoptionOf(claim, Number.POSITIVE_INFINITY);
    const store = new LocalStore(dir, SESSION);

    for (let poll = 1; poll <= 50; poll++) expect(store.drainBuffer()).toEqual([]);
    expect(gaveUpWarnings()).toEqual([]);

    expect(tools(store.drainBuffer())).toEqual(['B:pre']);
    for (let poll = 1; poll <= 5; poll++) expect(store.drainBuffer()).toEqual([]);
    expect(gaveUpWarnings()).toEqual([expect.objectContaining({ claim })]);
    expect(fs.existsSync(claim)).toBe(true);
  });

  it('drains the buffer past a claim it cannot adopt on the final drain', () => {
    const claim = writeClaim(DEAD_PID, Date.now() - 10_000, line('A', 'pre'));
    fs.writeFileSync(bufferPath, line('B', 'pre'));
    refuseAdoptionOf(claim, Number.POSITIVE_INFINITY);
    const store = new LocalStore(dir, SESSION);
    store.giveUpHeldOrder();

    expect(tools(store.drainBuffer())).toEqual(['B:pre']);
  });

  it("takes its own leftover claims of other sessions' buffers after it switches to a scoped drain", () => {
    fs.writeFileSync(resolve(dir, 'buffer-other.jsonl'), line('Other', 'post', 'other'));
    crashMidDrain(REAL_PID, 'other');
    fs.writeFileSync(bufferPath, line('A'));

    const events = new LocalStore(dir, SESSION).drainBuffer();

    expect(events.map((e) => `${'sessionId' in e ? e.sessionId : ''}:${e.tool}`)).toEqual([
      'other:Other',
      `${SESSION}:A`,
    ]);
    expect(fs.readdirSync(drainsDir())).toEqual([]);
  });

  it("leaves other sessions' buffers and other processes' claims of them to their drainers", () => {
    const other = resolve(dir, 'buffer-other.jsonl');
    fs.writeFileSync(other, line('Other', 'post', 'other'));
    crashMidDrain(DEAD_PID, 'other');
    fs.writeFileSync(other, line('Other2', 'post', 'other'));
    fs.writeFileSync(bufferPath, line('A'));

    expect(tools(new LocalStore(dir, SESSION).drainBuffer())).toEqual(['A']);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readdirSync(drainsDir())).toHaveLength(1);
  });

  it('does not warn when another drainer adopted its claim before the unlink', () => {
    fs.writeFileSync(bufferPath, line('A'));
    let adopter: HookEvent[] = [];
    mockHooks.unlink = () => {
      adopter = asProcess(REAL_PID, () => new LocalStore(dir, SESSION).drainBuffer());
    };
    const dying = asProcess(DEAD_PID, () => new LocalStore(dir, SESSION).drainBuffer());

    expect(tools([...dying, ...adopter])).toEqual(['A']);
    expect(warnings()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('backs off its warnings for a claim it keeps failing to read', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const unreadable = (): void => {
      mockHooks.drainRead = unreadable;
      throw failing('EACCES');
    };
    mockHooks.drainRead = unreadable;
    const store = new LocalStore(dir, SESSION);

    for (let i = 0; i < 10; i++) expect(store.drainBuffer()).toEqual([]);
    expect(warnings()).toHaveLength(4);

    mockHooks.drainRead = null;
    expect(tools(store.drainBuffer())).toEqual(['A']);
  });

  it('backs off its warnings for a buffer it keeps failing to claim', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const refused = (): void => {
      mockHooks.rename = refused;
      throw failing('EACCES');
    };
    mockHooks.rename = refused;
    const store = new LocalStore(dir, SESSION);

    for (let i = 0; i < 10; i++) expect(store.drainBuffer()).toEqual([]);
    expect(warnings()).toHaveLength(4);
    expect(fs.existsSync(bufferPath)).toBe(true);

    mockHooks.rename = null;
    expect(tools(store.drainBuffer())).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it('warns once per failed stretch of drain claim listings', () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    stderr.mockClear();
    let broken = true;
    mockHooks.listOrder = (path, names) => {
      if (broken && path.endsWith('drains')) throw failing('EACCES');
      return names;
    };

    const store = new LocalStore(dir, SESSION);
    expect([...store.drainBuffer(), ...store.drainBuffer()]).toEqual([]);
    expect(warnings()).toHaveLength(1);

    broken = false;
    expect(tools(store.drainBuffer())).toEqual(['A']);
    expect(leftovers()).toEqual([]);

    broken = true;
    expect(store.drainBuffer()).toEqual([]);
    expect(warnings()).toHaveLength(2);
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
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(REAL_PID);
    const unlinkRefused = (): void => {
      mockHooks.unlink = unlinkRefused;
      throw failing('EPERM');
    };

    mockHooks.unlink = unlinkRefused;
    const whileRefused = [
      ...new LocalStore(dir, SESSION).drainBuffer(),
      ...new LocalStore(dir, SESSION).drainBuffer(),
    ];
    mockHooks.unlink = null;
    const afterRestart = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools([...whileRefused, ...afterRestart])).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it('returns claims written in the same millisecond in one order whatever the listing order', () => {
    const at = Date.now() - 10_000;
    const drainWith = (list: (names: string[]) => string[]): string[] => {
      writeClaim(DEAD_PID, at, line('A'));
      writeClaim(DEAD_PID - 1, at, line('B'));
      mockHooks.listOrder = (_d, names) => list([...names]);
      return tools(new LocalStore(dir, SESSION).drainBuffer());
    };

    const ascending = drainWith((names) => names.sort());
    const descending = drainWith((names) => names.sort().reverse());

    expect(ascending).toEqual(['B', 'A']);
    expect(descending).toEqual(['B', 'A']);
  });

  it("leaves a dead process's claim to a session owner that is already live", () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    fs.writeFileSync(resolve(dir, `active-${SESSION}.pid`), String(OTHER_LIVE_PID));

    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);
    expect(leftovers()).toHaveLength(1);

    const owner = asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer());
    expect(tools(owner)).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it("drainAllBuffers leaves a live process's young claim alone and adopts it once it is stale", () => {
    writeClaim(OTHER_LIVE_PID, Date.now() - 1_000, line('A'));

    expect(new LocalStore(dir).drainAllBuffers()).toEqual([]);
    expect(leftovers()).toHaveLength(1);

    later(10 * 60_000);
    expect(tools(new LocalStore(dir).drainAllBuffers())).toEqual(['A']);
    expect(leftovers()).toEqual([]);
  });

  it("returns a dead claim once when a second adopter runs inside the first one's rename", () => {
    fs.writeFileSync(bufferPath, line('A'));
    crashMidDrain(DEAD_PID);
    let second: HookEvent[] = [];

    mockHooks.rename = (from, to) => {
      second = asProcess(OTHER_LIVE_PID, () => new LocalStore(dir, SESSION).drainBuffer());
      fs.renameSync(from, to);
    };
    const first = new LocalStore(dir, SESSION).drainBuffer();

    expect(tools([...first, ...second])).toEqual(['A']);
    expect(first).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});

describe('hook writes racing a drain', () => {
  it('keeps a write that opened the buffer before a drain and wrote after the drain finished', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const drainer = new LocalStore(dir, SESSION);
    let duringWrite: HookEvent[] = [];
    mockHooks.write = (text) => {
      if (text !== line('B')) return;
      mockHooks.write = null;
      duringWrite = drainer.drainBuffer();
    };

    appendToHookBuffer(bufferPath, line('B'));

    expect(tools(duringWrite)).toEqual(['A']);
    expect(tools(drainer.drainBuffer())).toEqual(['B']);
    expect(leftovers()).toEqual([]);
  });

  it('leaves a line that lands between the GC rename and the archive seal in the archive', () => {
    fs.writeFileSync(bufferPath, line('A'));
    fs.writeFileSync(resolve(dir, `active-${SESSION}.pid`), String(DEAD_PID));
    const openBeforeGc = fs.openSync(bufferPath, 'a');
    mockHooks.rename = (from, to) => {
      fs.renameSync(from, to);
      fs.writeSync(openBeforeGc, line('B'));
    };
    const store = new LocalStore(dir, SESSION);

    expect(store.gcOrphanBuffers(new Set()).archived).toBe(1);
    fs.closeSync(openBeforeGc);

    const archive = fs.readdirSync(dir).find((n) => n.includes('.archived-'));
    expect(fs.readFileSync(resolve(dir, archive!), 'utf-8')).toBe(line('A') + line('B') + SEAL);
    expect(store.drainBuffer()).toEqual([]);
  });

  it('keeps a write that opened an orphan buffer before GC archived it and wrote after the seal', () => {
    fs.writeFileSync(bufferPath, line('A'));
    fs.writeFileSync(resolve(dir, `active-${SESSION}.pid`), String(DEAD_PID));
    const store = new LocalStore(dir, SESSION);
    mockHooks.write = (text) => {
      if (text !== line('B')) return;
      mockHooks.write = null;
      expect(store.gcOrphanBuffers(new Set()).archived).toBe(1);
    };

    appendToHookBuffer(bufferPath, line('B'));

    expect(tools(store.drainBuffer())).toEqual(['B']);
  });

  it('still counts the archive and clears the heartbeat when the archive seal throws', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const heartbeat = resolve(dir, `active-${SESSION}.pid`);
    fs.writeFileSync(heartbeat, String(DEAD_PID));
    mockHooks.write = (text) => {
      if (!text.includes(SEAL)) return;
      mockHooks.write = null;
      throw new Error('ENOSPC: seal failed');
    };

    const result = new LocalStore(dir, SESSION).gcOrphanBuffers(new Set());

    expect(result.archived).toBe(1);
    expect(fs.existsSync(heartbeat)).toBe(false);
    expect(JSON.stringify(warnings())).toContain('Failed to seal archived orphan buffer');
  });

  it('returns a line written to a claim just before its seal, exactly once', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const openBeforeDrain = fs.openSync(bufferPath, 'a');
    mockHooks.write = (text) => {
      if (!text.includes(SEAL)) return;
      mockHooks.write = null;
      fs.writeSync(openBeforeDrain, line('B'));
    };
    const drainer = new LocalStore(dir, SESSION);

    const got = [...drainer.drainBuffer(), ...drainer.drainBuffer()];
    fs.closeSync(openBeforeDrain);

    expect(tools(got)).toEqual(['A', 'B']);
    expect(leftovers()).toEqual([]);
  });
});

describe('drain seals', () => {
  it('peekAllBuffers counts only the lines before a claim seal', () => {
    writeClaim(OTHER_LIVE_PID, Date.now(), line('A') + SEAL + line('B'));
    fs.writeFileSync(bufferPath, line('B'));

    expect(tools(new LocalStore(dir).peekAllBuffers()).sort()).toEqual(['A', 'B']);
    expect(warnings()).toEqual([]);
  });

  it('keeps a hook line written to the legacy buffer after migration read it', () => {
    const legacyPath = resolve(dir, 'buffer.jsonl');
    fs.writeFileSync(legacyPath, line('A'));
    const store = new LocalStore(dir);
    mockHooks.write = (text) => {
      if (!text.includes('"B"')) return;
      mockHooks.write = null;
      store.migrateLegacyBuffer();
    };

    appendToHookBuffer(legacyPath, line('B'));

    expect(tools(store.peekAllBuffers()).sort()).toEqual(['A', 'B']);
  });

  it('migrates each legacy line once when a write comes up short', () => {
    const legacyPath = resolve(dir, 'buffer.jsonl');
    fs.writeFileSync(legacyPath, line('A') + line('B') + line('C'));
    mockHooks.shortWrite = (text) => (text.includes('"A"') ? Math.floor(text.length / 2) : null);

    new LocalStore(dir).migrateLegacyBuffer();
    mockHooks.shortWrite = null;

    expect(tools(new LocalStore(dir, SESSION).drainBuffer()).sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps the legacy migration file when an append cannot land', () => {
    const legacyPath = resolve(dir, 'buffer.jsonl');
    fs.writeFileSync(legacyPath, line('A'));
    const drainer = new LocalStore(dir, SESSION);
    mockHooks.write = (text) => {
      if (text.includes('"A"')) drainer.drainBuffer();
    };

    new LocalStore(dir).migrateLegacyBuffer();
    mockHooks.write = null;

    expect(fs.readdirSync(dir).filter((n) => n.startsWith('buffer.jsonl.migrating-'))).toHaveLength(
      1,
    );
    expect(warnings()).not.toEqual([]);
  });
});
