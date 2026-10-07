import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('node:fs', () => ({
  existsSync: jest.fn(() => false),
  realpathSync: jest.fn((p: unknown) => p),
}));
jest.mock('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

import * as fsMod from 'node:fs';
import * as childMod from 'node:child_process';

import {
  detectUpdateSupport,
  updateBlockerLines,
  upgradeCommandFor,
  UPGRADE_COMMAND,
} from './update-support.js';

const mockedFs = fsMod as unknown as { existsSync: jest.Mock; realpathSync: jest.Mock };
const mockedChild = childMod as unknown as { execFileSync: jest.Mock };

function placeEntryPoint(packageRoot: string): void {
  mockedFs.realpathSync.mockReturnValue(`${packageRoot}/dist/index.js`);
  mockedFs.existsSync.mockImplementation(
    (p: unknown) => String(p) === `${packageRoot}/package.json`,
  );
}

describe('detectUpdateSupport', () => {
  const savedArgv1 = process.argv[1];

  beforeEach(() => {
    process.argv[1] = '/entry/dist/index.js';
    mockedFs.existsSync.mockImplementation(() => false);
    mockedFs.realpathSync.mockImplementation((p: unknown) => p);
    mockedChild.execFileSync.mockReset();
  });

  afterEach(() => {
    process.argv[1] = savedArgv1;
  });

  it('is supported on a source clone and reports its root', () => {
    placeEntryPoint('/home/user/preflight');
    mockedChild.execFileSync.mockReturnValue('/home/user/preflight\n');
    expect(detectUpdateSupport()).toEqual({ supported: true, repoRoot: '/home/user/preflight' });
  });

  it('is blocked with no-repo-root when no package.json is found above the entry point', () => {
    expect(detectUpdateSupport()).toEqual({ supported: false, blocker: 'no-repo-root' });
  });

  it('is blocked with no-git when git is not installed', () => {
    placeEntryPoint('/home/user/preflight');
    mockedChild.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    });
    expect(detectUpdateSupport()).toEqual({ supported: false, blocker: 'no-git' });
  });

  it('is blocked with package-manager when the package root is not in a git repo', () => {
    placeEntryPoint('/usr/local/lib/node_modules/@newrelic/preflight');
    mockedChild.execFileSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(detectUpdateSupport()).toEqual({ supported: false, blocker: 'package-manager' });
  });

  it('is blocked with package-manager when the package sits under node_modules inside a git tree', () => {
    placeEntryPoint('/work/app/node_modules/@newrelic/preflight');
    mockedChild.execFileSync.mockReturnValue('/work/app\n');
    expect(detectUpdateSupport()).toEqual({ supported: false, blocker: 'package-manager' });
  });

  it('is blocked with homebrew before git is consulted, even inside Homebrew own git repo', () => {
    placeEntryPoint(
      '/opt/homebrew/Cellar/preflight/1.57.4/libexec/lib/node_modules/@newrelic/preflight',
    );
    mockedChild.execFileSync.mockReturnValue('/opt/homebrew\n');
    expect(detectUpdateSupport()).toEqual({ supported: false, blocker: 'homebrew' });
    expect(mockedChild.execFileSync).not.toHaveBeenCalled();
  });
});

describe('updateBlockerLines and upgradeCommandFor', () => {
  it('gives npm advice for a package-manager install', () => {
    expect(updateBlockerLines('package-manager').join('\n')).toContain(UPGRADE_COMMAND);
    expect(upgradeCommandFor('package-manager')).toBe(UPGRADE_COMMAND);
  });

  it('gives brew advice, not npm advice, for a Homebrew install', () => {
    const text = updateBlockerLines('homebrew').join('\n');
    expect(text).toContain('brew upgrade preflight');
    expect(text).not.toContain('npm install');
    expect(upgradeCommandFor('homebrew')).toBe('brew upgrade preflight');
  });

  it('tells the user to install git when git is missing', () => {
    expect(updateBlockerLines('no-git').join('\n')).toContain('git is not installed');
  });
});
