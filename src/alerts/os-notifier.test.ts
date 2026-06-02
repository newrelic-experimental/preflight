import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { OsNotifier, type ExecFileFn } from './os-notifier.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: readonly string[];
}

function mockSuccess(): { exec: ExecFileFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFileFn = (cmd, args, cb) => {
    calls.push({ cmd, args });
    queueMicrotask(() => cb(null, '', ''));
    return undefined;
  };
  return { exec, calls };
}

function mockFailure(error: NodeJS.ErrnoException = new Error('boom') as NodeJS.ErrnoException): {
  exec: ExecFileFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFileFn = (cmd, args, cb) => {
    calls.push({ cmd, args });
    queueMicrotask(() => cb(error, '', ''));
    return undefined;
  };
  return { exec, calls };
}

function makeLogger(): { warn: jest.Mock; entries: Array<{ msg: string; meta?: object }> } {
  const entries: Array<{ msg: string; meta?: object }> = [];
  const warn = jest.fn((msg: unknown, meta?: unknown) => {
    entries.push({ msg: String(msg), meta: meta as object | undefined });
  });
  return { warn, entries };
}

// ---------------------------------------------------------------------------
// macOS branch
// ---------------------------------------------------------------------------

describe('OsNotifier — darwin', () => {
  it('invokes osascript with -e and the display-notification script', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'darwin', exec });
    await notifier.notify({ title: 'Hello', body: 'World' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('osascript');
    expect(calls[0]!.args).toEqual([
      '-e',
      'display notification "World" with title "Hello"',
    ]);
  });

  it('strips double-quotes, backslashes, single-quotes, and backticks from inputs', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'darwin', exec });
    await notifier.notify({
      title: 'a"b\\c\'d`e',
      body: 'x"y\\z\'w`q',
    });

    const script = calls[0]!.args[1] ?? '';
    expect(script).toBe('display notification "xyzwq" with title "abcde"');
    expect(script).not.toContain('"a"b');
    expect(script).not.toContain('\\');
  });

  it('truncates inputs over 120 characters', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'darwin', exec });
    const longTitle = 'A'.repeat(200);
    const longBody = 'B'.repeat(200);
    await notifier.notify({ title: longTitle, body: longBody });

    const script = calls[0]!.args[1] ?? '';
    // 120 As + 120 Bs in the interpolated script
    const titleMatch = /with title "(.+?)"$/.exec(script);
    const bodyMatch = /display notification "(.+?)"/.exec(script);
    expect(titleMatch?.[1]?.length).toBe(120);
    expect(bodyMatch?.[1]?.length).toBe(120);
  });

  it('catches execFile errors and logs them', async () => {
    const { exec } = mockFailure();
    const log = makeLogger();
    const notifier = new OsNotifier({
      platform: 'darwin',
      exec,
      logger: log,
    });
    await expect(
      notifier.notify({ title: 'a', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(log.entries[0]?.msg).toMatch(/unexpected error/i);
  });

  it('strips ASCII control characters', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'darwin', exec });
    await notifier.notify({
      title: 'a\x00b\x1fc\x7fd',
      body: 'x\x00y',
    });
    const script = calls[0]!.args[1] ?? '';
    expect(script).toBe('display notification "xy" with title "abcd"');
  });
});

// ---------------------------------------------------------------------------
// Linux branch
// ---------------------------------------------------------------------------

describe('OsNotifier — linux', () => {
  it('invokes notify-send with -- guard and discrete title/body args', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'linux', exec });
    await notifier.notify({ title: 'Hello', body: 'World' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('notify-send');
    expect(calls[0]!.args).toEqual(['--', 'Hello', 'World']);
  });

  it('catches missing notify-send (ENOENT) without throwing', async () => {
    const enoent = new Error('spawn notify-send ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    const { exec } = mockFailure(enoent);
    const log = makeLogger();
    const notifier = new OsNotifier({ platform: 'linux', exec, logger: log });
    await expect(
      notifier.notify({ title: 'a', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Windows branch
// ---------------------------------------------------------------------------

describe('OsNotifier — win32', () => {
  it('invokes powershell.exe with -NoProfile and BurntToast script', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'win32', exec });
    await notifier.notify({ title: 'T', body: 'B' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('powershell.exe');
    expect(calls[0]!.args[0]).toBe('-NoProfile');
    expect(calls[0]!.args[1]).toBe('-Command');
    expect(calls[0]!.args[2]).toContain('New-BurntToastNotification');
    expect(calls[0]!.args[2]).toContain("'T','B'");
  });

  it('falls back to balloon-tip when BurntToast fails', async () => {
    const calls: ExecCall[] = [];
    let invocation = 0;
    const exec: ExecFileFn = (cmd, args, cb) => {
      calls.push({ cmd, args });
      invocation += 1;
      const err = invocation === 1 ? (new Error('not installed') as NodeJS.ErrnoException) : null;
      queueMicrotask(() => cb(err, '', ''));
      return undefined;
    };
    const log = makeLogger();
    const notifier = new OsNotifier({ platform: 'win32', exec, logger: log });
    await notifier.notify({ title: 'T', body: 'B' });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.cmd).toBe('powershell.exe');
    expect(calls[1]!.args[2]).toContain('NotifyIcon');
    expect(calls[1]!.args[2]).toContain('BalloonTipTitle');
    // Warning logged about BurntToast being unavailable.
    expect(
      log.entries.some((e) => /BurntToast/i.test(e.msg)),
    ).toBe(true);
  });

  it('logs and returns when BOTH BurntToast and balloon-tip fail', async () => {
    const exec: ExecFileFn = (_cmd, _args, cb) => {
      queueMicrotask(() => cb(new Error('powershell missing') as NodeJS.ErrnoException, '', ''));
      return undefined;
    };
    const log = makeLogger();
    const notifier = new OsNotifier({ platform: 'win32', exec, logger: log });
    await expect(
      notifier.notify({ title: 'T', body: 'B' }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(
      log.entries.some((e) => /balloon-tip/i.test(e.msg)),
    ).toBe(true);
  });

  it('strips single-quotes and backticks before interpolating into PowerShell literals', async () => {
    const { exec, calls } = mockSuccess();
    const notifier = new OsNotifier({ platform: 'win32', exec });
    await notifier.notify({ title: "a'b`c", body: "x'y`z" });
    const script = calls[0]!.args[2] ?? '';
    // Sanitised: single quotes and backticks gone; what remains is interpolated
    // into single-quoted PowerShell literals.
    expect(script).toContain("'abc','xyz'");
    expect(script).not.toContain("'a'b");
    expect(script).not.toContain('`');
  });
});

// ---------------------------------------------------------------------------
// Unsupported platform / empty input
// ---------------------------------------------------------------------------

describe('OsNotifier — fallbacks', () => {
  it('is a no-op on unsupported platforms', async () => {
    const { exec, calls } = mockSuccess();
    const log = makeLogger();
    const notifier = new OsNotifier({
      platform: 'freebsd',
      exec,
      logger: log,
    });
    await notifier.notify({ title: 'a', body: 'b' });
    expect(calls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
    expect(log.entries[0]?.msg).toMatch(/unsupported platform/i);
  });

  it('is a no-op when both title and body sanitise to empty', async () => {
    const { exec, calls } = mockSuccess();
    const log = makeLogger();
    const notifier = new OsNotifier({
      platform: 'darwin',
      exec,
      logger: log,
    });
    await notifier.notify({ title: '"\\\'`', body: '"\\\'`' });
    expect(calls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('catches synchronous throws from execFile', async () => {
    const exec: ExecFileFn = () => {
      throw new Error('synchronous boom');
    };
    const log = makeLogger();
    const notifier = new OsNotifier({
      platform: 'darwin',
      exec,
      logger: log,
    });
    await expect(
      notifier.notify({ title: 'a', body: 'b' }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('uses the injected platform default when none is provided', () => {
    // Just confirms the constructor picks up process.platform without error.
    const notifier = new OsNotifier();
    expect(notifier).toBeInstanceOf(OsNotifier);
  });
});
