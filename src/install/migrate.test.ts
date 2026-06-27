import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as fsMod from 'node:fs';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  realpathSync: jest.fn((p: unknown) => p),
  cpSync: jest.fn(),
  rmSync: jest.fn(),
  readSync: jest.fn(() => 0),
  openSync: jest.fn(() => 3),
  closeSync: jest.fn(),
}));

import { migrateStoragePath } from './migrate.js';

// Paths mirror what migrate.ts derives from DEFAULT_STORAGE_PATH at runtime.
const STORAGE = resolve(homedir(), '.newrelic-preflight');
const MARKER = resolve(STORAGE, '.wsl-mode');
const CONFIG = resolve(STORAGE, 'config.json');
const CONFIG_TMP = CONFIG + '.tmp';
const OLD_PATH = resolve(homedir(), '.nr-ai-observe');

type MockedFs = {
  existsSync: jest.Mock;
  readFileSync: jest.Mock;
  writeFileSync: jest.Mock;
  renameSync: jest.Mock;
  unlinkSync: jest.Mock;
};

// ---------------------------------------------------------------------------
// migrateWslMarker — tested via the exported migrateStoragePath wrapper.
// The old-path migration (nr-ai-observe → newrelic-preflight) is suppressed
// by making existsSync return false for OLD_PATH, so only the marker logic runs.
// ---------------------------------------------------------------------------

describe('migrateWslMarker (via migrateStoragePath)', () => {
  let mFs: MockedFs;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    mFs = fsMod as unknown as MockedFs;
    // Re-arm implementations that clearAllMocks() leaves stale between tests.
    // clearAllMocks() only clears call records; mockImplementation() values persist.
    // Any test that sets a custom implementation (e.g. unlinkSync that throws) would
    // bleed into later tests without an explicit reset here.
    (fsMod as unknown as { realpathSync: jest.Mock }).realpathSync.mockImplementation(
      (p: unknown) => p,
    );
    mFs.writeFileSync.mockImplementation(() => {});
    mFs.renameSync.mockImplementation(() => {});
    mFs.unlinkSync.mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Default: only the marker file exists; old storage path does not.
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === MARKER);
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      return '{}'; // default empty config
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('is a no-op when .wsl-mode does not exist', () => {
    mFs.existsSync.mockReturnValue(false);

    migrateStoragePath();

    expect(mFs.writeFileSync).not.toHaveBeenCalled();
    expect(mFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('migrates .wsl-mode "windows" to platformTarget wsl-windows-cc in config.json', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(String(configWrite![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-windows-cc');
    expect(mFs.renameSync).toHaveBeenCalledWith(CONFIG_TMP, CONFIG);
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });

  it('migrates .wsl-mode "linux" to platformTarget wsl-linux-cc in config.json', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'linux';
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    const written = JSON.parse(String(configWrite![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-linux-cc');
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });

  it('preserves existing config.json fields when migrating', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'linux';
      if (String(p) === CONFIG)
        return JSON.stringify({ licenseKey: 'NRLIC-existing', accountId: '12345' });
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    const written = JSON.parse(String(configWrite![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-linux-cc');
    expect(written.licenseKey).toBe('NRLIC-existing');
    expect(written.accountId).toBe('12345');
  });

  it('skips config.json write when platformTarget is already set by a ≥1.0.4 install', () => {
    // User ran `preflight install --linux-cc` (platformTarget already wsl-linux-cc).
    // A stale .wsl-mode marker with 'windows' must not revert the user's explicit choice.
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      if (String(p) === CONFIG) return JSON.stringify({ platformTarget: 'wsl-linux-cc' });
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrite).toBeUndefined();
    // The stale marker must still be deleted.
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });

  it('migrates .wsl-mode when config.json has platformTarget "native" (cross-machine copy)', () => {
    // User copied their macOS config.json (platformTarget='native') to a WSL machine
    // that also has a .wsl-mode marker. 'native' must not suppress the migration —
    // it was written on a non-WSL machine and does not reflect a deliberate WSL choice.
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      if (String(p) === CONFIG) return JSON.stringify({ platformTarget: 'native' });
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(String(configWrite![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-windows-cc');
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });

  it('deletes marker with unrecognized content without writing config.json', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'unrecognized-value';
      return '{}';
    });

    migrateStoragePath();

    expect(mFs.writeFileSync).not.toHaveBeenCalled();
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });

  it('does not write config.json when config.json is malformed (no credential wipe)', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      if (String(p) === CONFIG) return '{"licenseKey": "NRLIC-truncated'; // malformed JSON
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === MARKER || String(p) === CONFIG);

    expect(() => migrateStoragePath()).not.toThrow();

    const configWrites = mFs.writeFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrites).toHaveLength(0);
  });

  it('does not write config.json when config.json is unreadable (no credential wipe)', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'linux';
      if (String(p) === CONFIG) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      }
      return '{}';
    });
    mFs.existsSync.mockImplementation((p: unknown) => String(p) === MARKER || String(p) === CONFIG);

    expect(() => migrateStoragePath()).not.toThrow();

    const configWrites = mFs.writeFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrites).toHaveLength(0);
  });

  it('is non-fatal when writeFileSync throws', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'windows';
      return '{}';
    });
    mFs.writeFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => migrateStoragePath()).not.toThrow();
  });

  it('is non-fatal when unlinkSync on marker throws after a successful write', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'linux';
      return '{}';
    });
    mFs.unlinkSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) throw new Error('EPERM: read-only file system');
    });

    expect(() => migrateStoragePath()).not.toThrow();
    // Config was still written before the marker delete failed
    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrite).toBeDefined();
  });

  it('handles trailing whitespace in marker content', () => {
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return '  windows  \n';
      return '{}';
    });

    migrateStoragePath();

    const configWrite = mFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    const written = JSON.parse(String(configWrite![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-windows-cc');
  });

  // The symlink guard in migrateWslMarker uses realpathSync to verify the storage
  // directory is inside HOME before writing. The mock returns the path as-is
  // (so DEFAULT_STORAGE_PATH resolves to itself, which starts with homedir()),
  // confirming the guard allows writes for the normal installation location.
  it('allows write when storage path resolves inside HOME', () => {
    migrateStoragePath();

    expect(mFs.writeFileSync).toHaveBeenCalled();
  });

  // migrateWslMarker passes DEFAULT_STORAGE_PATH as additionalAllowedBase so that
  // symlinked storage directories (e.g. ~/.newrelic-preflight → /data/shared/preflight)
  // are still writable. When realpathSync resolves DEFAULT_STORAGE_PATH outside HOME
  // the guard compares resolved paths on both sides and allows the write because the
  // user explicitly chose that storage location.
  it('allows write when storage path is symlinked outside HOME (storage dir is explicit allowed base)', () => {
    (fsMod as unknown as { realpathSync: jest.Mock }).realpathSync.mockReturnValue(
      '/data/shared/preflight',
    );

    migrateStoragePath();

    const configWrites = mFs.writeFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]) === CONFIG_TMP,
    );
    expect(configWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// migrateStoragePath — old-path migration (pre-existing; tested for
// interactions with the new migrateWslMarker call order)
// ---------------------------------------------------------------------------

describe('migrateStoragePath call order', () => {
  let mFs: MockedFs;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    mFs = fsMod as unknown as MockedFs;
    (fsMod as unknown as { realpathSync: jest.Mock }).realpathSync.mockImplementation(
      (p: unknown) => p,
    );
    mFs.writeFileSync.mockImplementation(() => {});
    mFs.renameSync.mockImplementation(() => {});
    mFs.unlinkSync.mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('runs migrateWslMarker before checking old storage path', () => {
    // Both marker and old path exist.
    mFs.existsSync.mockImplementation(
      (p: unknown) => String(p) === MARKER || String(p) === OLD_PATH,
    );
    mFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === MARKER) return 'linux';
      return '{}';
    });

    migrateStoragePath();

    // migrateWslMarker ran first: config was updated and marker was deleted.
    const configCall = mFs.writeFileSync.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith('config.json.tmp'),
    );
    expect(configCall).toBeDefined();
    const written = JSON.parse(String(configCall![1])) as Record<string, unknown>;
    expect(written.platformTarget).toBe('wsl-linux-cc');
    expect(mFs.unlinkSync).toHaveBeenCalledWith(MARKER);
  });
});
