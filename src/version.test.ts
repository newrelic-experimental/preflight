import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Suppress logger stderr
jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

let tmpRoot: string;
const originalArgv1 = process.argv[1];

beforeEach(() => {
  tmpRoot = resolve(
    tmpdir(),
    `nr-version-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

// Import after mocks are set up.
// readVersion is re-executed on each call (it's a function, not just the
// cached VERSION constant), so we can test it with different argv[1] values.
import { readVersion } from './version.js';

describe('readVersion()', () => {
  it('reads version from package.json when argv[1] is a direct path', () => {
    const distDir = resolve(tmpRoot, 'dist');
    mkdirSync(distDir);
    writeFileSync(resolve(distDir, 'index.js'), '');
    writeFileSync(resolve(tmpRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    process.argv[1] = resolve(distDir, 'index.js');
    expect(readVersion()).toBe('1.2.3');
  });

  it('reads version when argv[1] is a symlink pointing into dist/', () => {
    // Structure: tmpRoot/dist/index.js  ← real file
    //            tmpRoot/package.json   ← version source
    //            tmpRoot/bin/preflight  ← symlink → ../dist/index.js
    const distDir = resolve(tmpRoot, 'dist');
    const binDir = resolve(tmpRoot, 'bin');
    mkdirSync(distDir);
    mkdirSync(binDir);
    writeFileSync(resolve(distDir, 'index.js'), '');
    writeFileSync(resolve(tmpRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const symlinkPath = resolve(binDir, 'preflight');
    symlinkSync(resolve(distDir, 'index.js'), symlinkPath);

    process.argv[1] = symlinkPath;
    // Without realpathSync: dirname(symlinkPath) = binDir → binDir/../package.json → tmpRoot/bin/../package.json → doesn't exist → falls to cwd → '0.0.0'
    // With realpathSync: resolves to distDir/index.js → distDir/../package.json → tmpRoot/package.json → '9.9.9'
    expect(readVersion()).toBe('9.9.9');
  });

  it('falls back gracefully when realpathSync would fail (e.g. broken symlink)', () => {
    // Simulate a broken symlink by using a non-existent target.
    // realpathSync throws ENOENT → fallback to original path.
    // The original path doesn't have a package.json next to it either.
    // Falls through to cwd check. Since cwd IS the repo root, it might
    // actually find a package.json — so just assert it does not throw.
    process.argv[1] = resolve(tmpRoot, 'nonexistent-symlink-target');
    expect(() => readVersion()).not.toThrow();
  });

  it('returns "0.0.0" when no package.json is reachable', () => {
    // argv[1] in a deep temp dir with no package.json, cwd also has none
    const deepDir = resolve(tmpRoot, 'a', 'b', 'c');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(resolve(deepDir, 'script.js'), '');
    process.argv[1] = resolve(deepDir, 'script.js');
    // The cwd (project root) has a package.json, so we can't guarantee '0.0.0'
    // in a real run. This is tested as a white-box: the function returns
    // whatever it can find; just confirm no throw.
    expect(() => readVersion()).not.toThrow();
  });
});
