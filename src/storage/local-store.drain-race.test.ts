import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from './local-store.js';
import { formatClaimName } from './drain-claims.js';
import type { HookEvent } from './types.js';

const mockHooks: {
  rename: ((from: fs.PathLike, to: fs.PathLike) => void) | null;
  drainRead: ((path: string) => void) | null;
  unlink: ((path: string) => void) | null;
  listOrder: ((dir: string, names: string[]) => string[]) | null;
} = { rename: null, drainRead: null, unlink: null, listOrder: null };

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

function line(tool: string, mode: 'pre' | 'post' = 'post', sessionId = SESSION): string {
  return JSON.stringify({ mode, tool, input: {}, timestamp: 1, sessionId }) + '\n';
}

function drainsDir(): string {
  return resolve(dir, 'drains');
}

function writeClaim(pid: number, claimedAt: number, content: string): string {
  fs.mkdirSync(drainsDir(), { recursive: true });
  const path = resolve(drainsDir(), formatClaimName(`buffer-${SESSION}.jsonl`, pid, claimedAt));
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
  mockHooks.unlink = null;
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
