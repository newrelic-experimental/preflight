import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { readJsonFileStrict, writeJsonFile, errMsg } from './json-utils.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nr-json-utils-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('errMsg', () => {
  it('returns the message for an Error instance', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error value', () => {
    expect(errMsg('plain string')).toBe('plain string');
  });
});

describe('readJsonFileStrict', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(readJsonFileStrict(join(tmpDir, 'missing.json'))).toEqual({});
  });

  it('parses a valid JSON object', () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, JSON.stringify({ licenseKey: 'NRLIC-x' }));
    expect(readJsonFileStrict(path)).toEqual({ licenseKey: 'NRLIC-x' });
  });

  it('throws when the file contains a JSON array instead of an object', () => {
    const path = join(tmpDir, 'array.json');
    writeFileSync(path, '[1,2,3]');
    expect(() => readJsonFileStrict(path)).toThrow(/Expected a JSON object but got array/);
  });

  it('throws when the file contains a JSON primitive instead of an object', () => {
    const path = join(tmpDir, 'primitive.json');
    writeFileSync(path, '"just a string"');
    expect(() => readJsonFileStrict(path)).toThrow(/Expected a JSON object but got string/);
  });

  it('throws on malformed JSON', () => {
    const path = join(tmpDir, 'broken.json');
    writeFileSync(path, '{not valid');
    expect(() => readJsonFileStrict(path)).toThrow(SyntaxError);
  });
});

describe('writeJsonFile', () => {
  it('writes the file inside the given directory when it is under HOME/cwd', () => {
    const path = join(tmpDir, 'sub', 'config.json');
    // tmpDir is not under HOME or cwd in CI — pass it as additionalAllowedBase
    // so the symlink guard accepts the write, mirroring real callers that pass
    // DEFAULT_STORAGE_PATH.
    writeJsonFile(path, { hello: 'world' }, tmpDir);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written).toEqual({ hello: 'world' });
  });

  it('propagates a non-ENOENT realpathSync failure on additionalAllowedBase', () => {
    if (process.getuid?.() === 0) {
      return; // root bypasses permission checks
    }
    const unreadableBase = join(tmpDir, 'unreadable');
    mkdirSync(unreadableBase);
    // Make the directory itself unreadable so realpathSync on a path inside it
    // fails with EACCES rather than ENOENT (it can't even stat the segment).
    chmodSync(unreadableBase, 0o000);
    try {
      expect(() =>
        writeJsonFile(join(tmpDir, 'out.json'), { a: 1 }, join(unreadableBase, 'nested')),
      ).toThrow(/EACCES/);
    } finally {
      chmodSync(unreadableBase, 0o755);
    }
  });
});
