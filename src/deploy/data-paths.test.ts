import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveDataDir } from './data-paths.js';

describe('resolveDataDir', () => {
  let root: string;
  let originalArgv1: string;
  let cwdSpy: ReturnType<typeof jest.spyOn> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'data-paths-test-'));
    originalArgv1 = process.argv[1]!;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.argv[1] = originalArgv1;
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
  });

  // scriptDir sits two levels below root, and cwd is a sibling of root, so the
  // six candidate paths (below) never overlap with one another.
  function setScriptAndCwd(scriptDir: string, cwd: string): void {
    process.argv[1] = join(scriptDir, 'index.js');
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
  }

  it('finds the bundledFromIndex candidate (<scriptDir>/data/<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(scriptDir, 'data', 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('finds the sourceTreeFromIndex candidate (<scriptDir>/../<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(root, 'x', 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('finds the bundledFromDeploy candidate (<scriptDir>/../data/<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(root, 'x', 'data', 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('finds the sourceTreeFromDeploy candidate (<scriptDir>/../../<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(root, 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('finds the fromCwd candidate (<cwd>/<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(cwd, 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('finds the bundledFromCwd candidate (<cwd>/dist/data/<name>)', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    const expected = join(cwd, 'dist', 'data', 'alerts');
    mkdirSync(expected, { recursive: true });
    setScriptAndCwd(scriptDir, cwd);
    expect(resolveDataDir('alerts')).toBe(expected);
  });

  it('throws an Error listing all six tried paths when none of the candidates exist', () => {
    const scriptDir = join(root, 'x', 'y');
    const cwd = join(root, 'cwd');
    setScriptAndCwd(scriptDir, cwd);

    let caught: Error | undefined;
    try {
      resolveDataDir('alerts');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught!.message;
    expect(message).toContain('Could not locate alerts/ data directory');
    expect(message).toContain(join(scriptDir, 'data', 'alerts'));
    expect(message).toContain(join(root, 'x', 'alerts'));
    expect(message).toContain(join(root, 'x', 'data', 'alerts'));
    expect(message).toContain(join(root, 'alerts'));
    expect(message).toContain(join(cwd, 'alerts'));
    expect(message).toContain(join(cwd, 'dist', 'data', 'alerts'));
  });
});
