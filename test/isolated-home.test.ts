import { describe, expect, it } from '@jest/globals';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_STORAGE_PATH } from '../src/config.js';

describe('test home isolation', () => {
  it('resolves the default storage path under the isolated temp home', () => {
    const isolated = process.env.PREFLIGHT_TEST_ISOLATED_HOME;
    expect(isolated).toBeTruthy();
    expect(homedir()).toBe(isolated);
    expect(DEFAULT_STORAGE_PATH).toBe(resolve(isolated as string, '.newrelic-preflight'));
  });
});
