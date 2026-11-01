import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendToHookBuffer, takeClaimText } from './hook-buffer.js';

const SEAL = '\0preflight-drain-seal\n';

const mockHooks: {
  beforeWrite: ((text: string) => void) | null;
  afterWrite: ((text: string) => void) | null;
  splitWrite: ((text: string) => (() => void) | null) | null;
  failSeal: (() => void) | null;
  shortSeal: boolean;
  bytesRead: number | null;
} = {
  beforeWrite: null,
  afterWrite: null,
  splitWrite: null,
  failSeal: null,
  shortSeal: false,
  bytesRead: null,
};

function textOf(data: unknown): string {
  return typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf-8');
}

function sealWrite(real: typeof fs, fd: number, text: string): number | null {
  if (!text.includes(SEAL)) return null;
  const fail = mockHooks.failSeal;
  if (fail) {
    mockHooks.failSeal = null;
    fail();
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  }
  if (mockHooks.shortSeal) {
    mockHooks.shortSeal = false;
    return real.writeSync(fd, text.slice(0, 7));
  }
  return real.writeSync(fd, text);
}

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof fs>('node:fs');
  return {
    ...real,
    writeSync: ((fd: number, data: unknown, ...rest: unknown[]) => {
      const text = textOf(data);
      const sealed = sealWrite(real, fd, text);
      if (sealed !== null) return sealed;
      const between = mockHooks.splitWrite?.(text);
      if (between) {
        mockHooks.splitWrite = null;
        const half = real.writeSync(fd, text.slice(0, Math.floor(text.length / 2)));
        between();
        return half;
      }
      mockHooks.beforeWrite?.(text);
      const n = (real.writeSync as (fd: number, data: unknown, ...rest: unknown[]) => number)(
        fd,
        data,
        ...rest,
      );
      mockHooks.afterWrite?.(text);
      return n;
    }) as typeof real.writeSync,
    writeFileSync: ((file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      if (typeof file !== 'number') {
        return (real.writeFileSync as (f: unknown, d: unknown, o?: unknown) => void)(
          file,
          data,
          options,
        );
      }
      const text = textOf(data);
      if (sealWrite(real, file, text) !== null) return;
      const between = mockHooks.splitWrite?.(text);
      if (between) {
        mockHooks.splitWrite = null;
        const half = Math.floor(text.length / 2);
        real.writeSync(file, text.slice(0, half));
        between();
        real.writeSync(file, text.slice(half));
        return;
      }
      mockHooks.beforeWrite?.(text);
      real.writeSync(file, text);
      mockHooks.afterWrite?.(text);
    }) as typeof real.writeFileSync,
    readSync: ((fd: number, ...rest: unknown[]) => {
      const n = (real.readSync as (fd: number, ...rest: unknown[]) => number)(fd, ...rest);
      if (mockHooks.bytesRead !== null) mockHooks.bytesRead += n;
      return n;
    }) as typeof real.readSync,
  };
});

let dir: string;
let bufferPath: string;
let claims: number;

function line(id: string): string {
  return JSON.stringify({ mode: 'post', tool: 'T', input: {}, timestamp: 1, id }) + '\n';
}

function ids(raw: string): string[] {
  const out: string[] = [];
  for (const l of raw.split('\n')) {
    try {
      out.push((JSON.parse(l) as { id: string }).id);
    } catch {
      continue;
    }
  }
  return out;
}

function live(): string[] {
  return fs.existsSync(bufferPath) ? ids(fs.readFileSync(bufferPath, 'utf-8')) : [];
}

function drainNow(): string[] {
  const claim = `${bufferPath}.claim-${claims++}`;
  fs.renameSync(bufferPath, claim);
  return ids(takeClaimText(claim));
}

function once(hook: (text: string) => void): (text: string) => void {
  return (text) => {
    mockHooks.beforeWrite = null;
    mockHooks.afterWrite = null;
    hook(text);
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(resolve(tmpdir(), 'nr-hook-buffer-'));
  bufferPath = resolve(dir, 'buffer-s.jsonl');
  claims = 0;
});

afterEach(() => {
  mockHooks.beforeWrite = null;
  mockHooks.afterWrite = null;
  mockHooks.splitWrite = null;
  mockHooks.failSeal = null;
  mockHooks.shortSeal = false;
  mockHooks.bytesRead = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendToHookBuffer', () => {
  it('appends each line to the buffer', () => {
    appendToHookBuffer(bufferPath, line('A'));
    appendToHookBuffer(bufferPath, line('B'));

    expect(live()).toEqual(['A', 'B']);
  });

  it('writes a line again to the live buffer when it landed after a seal', () => {
    fs.writeFileSync(bufferPath, line('A'));
    let drained: string[] = [];
    mockHooks.beforeWrite = once(() => (drained = drainNow()));

    appendToHookBuffer(bufferPath, line('B'));

    expect(drained).toEqual(['A']);
    expect(live()).toEqual(['B']);
  });

  it('does not write its line again when identical text from another writer follows the seal', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const otherWriter = fs.openSync(bufferPath, 'a');
    let drained: string[] = [];
    mockHooks.afterWrite = once((text) => {
      drained = drainNow();
      fs.writeSync(otherWriter, text);
    });

    appendToHookBuffer(bufferPath, line('X'));
    fs.closeSync(otherWriter);

    expect(drained).toEqual(['A', 'X']);
    expect(live()).toEqual([]);
  });

  it('reads only what follows its own open when it checks a sealed claim', () => {
    fs.writeFileSync(bufferPath, line('A').repeat(20_000));
    mockHooks.afterWrite = once(() => {
      const counting = mockHooks.bytesRead;
      mockHooks.bytesRead = null;
      drainNow();
      mockHooks.bytesRead = counting;
    });
    mockHooks.bytesRead = 0;

    appendToHookBuffer(bufferPath, line('B'));

    expect(mockHooks.bytesRead).toBeLessThan(4096);
  });

  it('throws when every attempt lands after a seal', () => {
    const drained: string[] = [];
    mockHooks.beforeWrite = () => drained.push(...drainNow());

    expect(() => appendToHookBuffer(bufferPath, line('B'))).toThrow(/attempts/);
    mockHooks.beforeWrite = null;
    expect([...drained, ...live()]).not.toContain('B');
  });

  it('writes a line again whole when a short write splits it around a seal', () => {
    fs.writeFileSync(bufferPath, line('A'));
    let drained: string[] = [];
    mockHooks.splitWrite = (text) => (text.includes('"B"') ? () => (drained = drainNow()) : null);

    appendToHookBuffer(bufferPath, line('B'));

    expect([...drained, ...live()]).toEqual(['A', 'B']);
  });
});

describe('takeClaimText', () => {
  it('returns the lines before the seal and deletes the claim', () => {
    fs.writeFileSync(bufferPath, line('A') + line('B'));

    expect(drainNow()).toEqual(['A', 'B']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps the claim and loses nothing when the seal write fails', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const claim = `${bufferPath}.claim`;
    fs.renameSync(bufferPath, claim);
    const writer = fs.openSync(claim, 'a');
    mockHooks.failSeal = () => fs.writeSync(writer, line('B'));

    expect(() => takeClaimText(claim)).toThrow(/ENOSPC/);
    fs.closeSync(writer);
    expect(fs.existsSync(claim)).toBe(true);
    expect(ids(takeClaimText(claim))).toEqual(['A', 'B']);
    expect(fs.existsSync(claim)).toBe(false);
  });

  it('seals a claim once however often its delete fails', () => {
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(bufferPath, line('A'));
    const claimDir = resolve(dir, 'drains');
    fs.mkdirSync(claimDir);
    const claim = resolve(claimDir, 'claim');
    fs.renameSync(bufferPath, claim);

    fs.chmodSync(claimDir, 0o500);
    try {
      expect(() => takeClaimText(claim)).toThrow(/EACCES/);
      expect(() => takeClaimText(claim)).toThrow(/EACCES/);
    } finally {
      fs.chmodSync(claimDir, 0o700);
    }

    expect(fs.readFileSync(claim, 'utf-8')).toBe(line('A') + SEAL);
    expect(ids(takeClaimText(claim))).toEqual(['A']);
  });

  it('drops the fragment of a short seal write and keeps the lines after it', () => {
    fs.writeFileSync(bufferPath, line('A'));
    const claim = `${bufferPath}.claim`;
    fs.renameSync(bufferPath, claim);
    mockHooks.shortSeal = true;

    expect(() => takeClaimText(claim)).toThrow();
    fs.appendFileSync(claim, line('B'));
    const raw = takeClaimText(claim);

    expect(raw).toBe(line('A') + line('B'));
  });
});
