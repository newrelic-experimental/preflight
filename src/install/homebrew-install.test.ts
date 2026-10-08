import { describe, it, expect } from '@jest/globals';

import { isHomebrewInstall } from './homebrew-install.js';

describe('isHomebrewInstall', () => {
  it.each([
    [
      'Apple Silicon',
      '/opt/homebrew/Cellar/preflight/1.57.4/libexec/lib/node_modules/@newrelic/preflight',
    ],
    ['Intel', '/usr/local/Cellar/preflight/1.57.4/libexec/lib/node_modules/@newrelic/preflight'],
    [
      'Linuxbrew',
      '/home/linuxbrew/.linuxbrew/Cellar/preflight/1.57.4/libexec/lib/node_modules/@newrelic/preflight',
    ],
    [
      'a revision suffix',
      '/opt/homebrew/Cellar/preflight/1.57.4_1/libexec/lib/node_modules/@newrelic/preflight',
    ],
  ])('is true for a %s keg', (_label, packageRoot) => {
    expect(isHomebrewInstall(packageRoot)).toBe(true);
  });

  it.each([
    ['an npm global install', '/usr/local/lib/node_modules/@newrelic/preflight'],
    [
      'an nvm install',
      '/Users/dev/.nvm/versions/node/v24.14.0/lib/node_modules/@newrelic/preflight',
    ],
    ['a source clone', '/Users/dev/src/preflight'],
    [
      'another formula in the Cellar',
      '/opt/homebrew/Cellar/other/1.0.0/libexec/lib/node_modules/@newrelic/preflight',
    ],
    [
      'a Cellar path without libexec',
      '/opt/homebrew/Cellar/preflight/1.57.4/lib/node_modules/@newrelic/preflight',
    ],
  ])('is false for %s', (_label, packageRoot) => {
    expect(isHomebrewInstall(packageRoot)).toBe(false);
  });
});
