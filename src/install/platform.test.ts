import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Silence stderr from logger
beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isWsl
// ---------------------------------------------------------------------------

describe('isWsl', () => {
  it('returns true when WSL_DISTRO_NAME is set', async () => {
    const orig = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    try {
      const { isWsl } = await import('./platform.js');
      expect(isWsl()).toBe(true);
    } finally {
      if (orig === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = orig;
      }
    }
  });

  it('returns false when WSL_DISTRO_NAME is absent and not on WSL kernel', async () => {
    const orig = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;
    try {
      const { isWsl } = await import('./platform.js');
      // On macOS (CI and dev), /proc/version does not exist, so this returns false.
      // On native Linux (non-WSL), /proc/version exists but lacks "microsoft".
      expect(isWsl()).toBe(false);
    } finally {
      if (orig !== undefined) process.env.WSL_DISTRO_NAME = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWindowsHome
// ---------------------------------------------------------------------------

describe('resolveWindowsHome', () => {
  it('converts USERPROFILE backslash path to WSL mount path', async () => {
    const orig = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\testuser';
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/testuser');
    } finally {
      if (orig === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = orig;
      }
    }
  });

  it('trims trailing whitespace from USERPROFILE before converting', async () => {
    const orig = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\testuser  '; // trailing spaces
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/testuser');
    } finally {
      if (orig === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = orig;
      }
    }
  });

  it('strips trailing backslash from USERPROFILE so symlink guard startsWith does not double-slash', async () => {
    const orig = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\testuser\\'; // trailing backslash (GPO/batch)
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/testuser');
    } finally {
      if (orig === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = orig;
      }
    }
  });

  it('converts USERPROFILE forward-slash path to WSL mount path', async () => {
    const orig = process.env.USERPROFILE;
    process.env.USERPROFILE = 'D:/Projects/alice';
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/d/Projects/alice');
    } finally {
      if (orig === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = orig;
      }
    }
  });

  it('handles HOMEPATH without a leading backslash by inserting a separator', async () => {
    const origUP = process.env.USERPROFILE;
    const origHD = process.env.HOMEDRIVE;
    const origHP = process.env.HOMEPATH;
    delete process.env.USERPROFILE;
    process.env.HOMEDRIVE = 'C:';
    process.env.HOMEPATH = 'Users\\bob'; // no leading backslash
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/bob');
    } finally {
      if (origUP === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUP;
      if (origHD === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = origHD;
      if (origHP === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = origHP;
    }
  });

  it('falls back to HOMEDRIVE + HOMEPATH when USERPROFILE is absent', async () => {
    const origUP = process.env.USERPROFILE;
    const origHD = process.env.HOMEDRIVE;
    const origHP = process.env.HOMEPATH;
    delete process.env.USERPROFILE;
    process.env.HOMEDRIVE = 'C:';
    process.env.HOMEPATH = '\\Users\\bob';
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/bob');
    } finally {
      if (origUP === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUP;
      if (origHD === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = origHD;
      if (origHP === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = origHP;
    }
  });

  it('handles HOMEDRIVE with trailing backslash so result has no double-slash', async () => {
    const origUP = process.env.USERPROFILE;
    const origHD = process.env.HOMEDRIVE;
    const origHP = process.env.HOMEPATH;
    delete process.env.USERPROFILE;
    process.env.HOMEDRIVE = 'C:\\'; // non-standard trailing backslash (GPO/batch misconfiguration)
    process.env.HOMEPATH = '\\Users\\carol';
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      expect(resolveWindowsHome()).toBe('/mnt/c/Users/carol');
    } finally {
      if (origUP === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUP;
      if (origHD === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = origHD;
      if (origHP === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = origHP;
    }
  });

  it('returns null when no Windows home env vars are present and cmd.exe unavailable', async () => {
    const origUP = process.env.USERPROFILE;
    const origHD = process.env.HOMEDRIVE;
    const origHP = process.env.HOMEPATH;
    delete process.env.USERPROFILE;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    try {
      const { resolveWindowsHome } = await import('./platform.js');
      // cmd.exe is not available on macOS/Linux, so this falls through to null.
      const result = resolveWindowsHome();
      expect(result).toBeNull();
    } finally {
      if (origUP !== undefined) process.env.USERPROFILE = origUP;
      if (origHD !== undefined) process.env.HOMEDRIVE = origHD;
      if (origHP !== undefined) process.env.HOMEPATH = origHP;
    }
  });
});
