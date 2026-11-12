import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendToHookBuffer, DRAIN_SEAL as SEAL, takeClaimText } from './hook-buffer.js';
import { LineWrittenError } from './hook-buffer.js';

const mockHooks: {
  beforeWrite: ((text: string) => void) | null;
  afterWrite: ((text: string) => void) | null;
  splitWrite: ((text: string) => (() => void) | null) | null;
  afterOpen: ((path: string) => void) | null;
  shortBy: number | null;
  failSeal: (() => void) | null;
  shortSeal: boolean;
  bytesRead: number | null;
  failClose: boolean;
} = {
  beforeWrite: null,
  afterWrite: null,
  splitWrite: null,
  afterOpen: null,
  shortBy: null,
  failSeal: null,
  shortSeal: false,
  bytesRead: null,
  failClose: false,
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
    openSync: ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = real.openSync(path, flags, mode);
      mockHooks.afterOpen?.(String(path));
      return fd;
    }) as typeof real.openSync,
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
      if (mockHooks.shortBy !== null && text.includes('"id"')) {
        const keep = Buffer.byteLength(text) - mockHooks.shortBy;
        mockHooks.shortBy = null;
        return real.writeSync(fd, Buffer.from(text).subarray(0, keep));
      }
      const n = (real.writeSync as (fd: number, data: unknown, ...rest: unknown[]) => number)(
        fd,
        data,
        ...rest,
      );
      mockHooks.afterWrite?.(text);
      return n;
    }) as typeof real.writeSync,
    closeSync: ((fd: number) => {
      real.closeSync(fd);
      if (mockHooks.failClose) {
        mockHooks.failClose = false;
        throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
      }
    }) as typeof real.closeSync,
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
  mockHooks.afterOpen = null;
  mockHooks.shortBy = null;
  mockHooks.failSeal = null;
  mockHooks.shortSeal = false;
  mockHooks.bytesRead = null;
  mockHooks.failClose = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('appendToHookBuffer', () => {
  it('appends each line to the buffer', () => {
    appendToHookBuffer(bufferPath, line('A'));
    appendToHookBuffer(bufferPath, line('B'));

    expect(live()).toEqual(['A', 'B']);
  });

  it('refuses text containing NUL, which would read as a drain seal', () => {
    expect(() => appendToHookBuffer(bufferPath, `{"a":"\0"}\n`)).toThrow(/NUL/);
    expect(fs.existsSync(bufferPath)).toBe(false);
  });

  it.each([
    ['two lines', `${line('A')}${line('B')}`],
    ['no newline', line('A').trimEnd()],
    ['an empty string', ''],
  ])('refuses text that is not one newline-terminated line (%s)', (_name, text) => {
    expect(() => appendToHookBuffer(bufferPath, text)).toThrow(/one newline-terminated line/);
    expect(fs.existsSync(bufferPath)).toBe(false);
  });

  it('reopens without writing when a drain finishes between its open and its check', () => {
    fs.writeFileSync(bufferPath, line('A'));
    let drained: string[] = [];
    mockHooks.afterOpen = (path) => {
      if (path !== bufferPath) return;
      mockHooks.afterOpen = null;
      drained = drainNow();
    };

    appendToHookBuffer(bufferPath, line('B'));

    expect(drained).toEqual(['A']);
    expect(live()).toEqual(['B']);
  });

  it('gives up after reopening 100 times without writing', () => {
    let opens = 0;
    mockHooks.afterOpen = (path) => {
      if (path !== bufferPath) return;
      fs.renameSync(bufferPath, `${bufferPath}.gone-${opens++}`);
    };

    expect(() => appendToHookBuffer(bufferPath, line('B'))).toThrow(/attempts/);

    expect(opens).toBe(100);
    expect(live()).toEqual([]);
  });

  it('keeps one copy when a short write drops only the trailing newline', () => {
    mockHooks.shortBy = 1;

    appendToHookBuffer(bufferPath, line('B'));

    expect(live()).toEqual(['B']);
  });

  it('keeps one copy when a short write leaves half a line', () => {
    mockHooks.shortBy = Math.floor(line('B').length / 2);

    appendToHookBuffer(bufferPath, line('B'));

    expect(live()).toEqual(['B']);
  });

  it('throws a written line error when the newline that ends a short write fails too', () => {
    mockHooks.shortBy = 1;
    mockHooks.beforeWrite = (text) => {
      if (text.includes('\x1e')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        });
      }
    };

    expect(() => appendToHookBuffer(bufferPath, line('B'))).toThrow(LineWrittenError);
  });

  const failCloseAfter = (text: string, setUp?: () => void) => (): void => {
    setUp?.();
    mockHooks.afterWrite = (written) => {
      if (written.includes(text)) mockHooks.failClose = true;
    };
  };
  it.each([
    ['the close after a whole line fails', true, failCloseAfter('"B"')],
    [
      'the close after a line that landed past a seal fails',
      false,
      () => {
        fs.writeFileSync(bufferPath, line('A'));
        mockHooks.beforeWrite = once(() => {
          drainNow();
          mockHooks.failClose = true;
        });
      },
    ],
    [
      'the close after a torn write fails',
      false,
      failCloseAfter('\x1e', () => (mockHooks.shortBy = 1)),
    ],
  ])(
    'marks the error as a written line only when a drain can read it: %s',
    (_label, written, fail) => {
      fail();

      let thrown: unknown;
      try {
        appendToHookBuffer(bufferPath, line('B'));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown instanceof LineWrittenError).toBe(written);
    },
  );

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
    let writes = 0;
    mockHooks.beforeWrite = () => {
      writes++;
      drained.push(...drainNow());
    };

    expect(() => appendToHookBuffer(bufferPath, line('B'))).toThrow(/attempts/);
    mockHooks.beforeWrite = null;
    expect(writes).toBe(5);
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

  it('reads a claim it cannot open for writing without sealing it', () => {
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(bufferPath, line('A'));
    const claim = `${bufferPath}.claim`;
    fs.renameSync(bufferPath, claim);
    fs.chmodSync(claim, 0o444);

    expect(ids(takeClaimText(claim))).toEqual(['A']);
    expect(fs.existsSync(claim)).toBe(false);
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
