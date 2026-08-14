import { describe, it, expect } from '@jest/globals';
import { checkNodeVersion } from './node-version-check.js';

describe('checkNodeVersion()', () => {
  it('returns null when the running Node version meets the floor', () => {
    expect(checkNodeVersion('v22.0.0')).toBeNull();
    expect(checkNodeVersion('v24.18.0')).toBeNull();
  });

  it('returns a diagnostic message when Node is below the floor', () => {
    const message = checkNodeVersion('v16.20.0');
    expect(message).not.toBeNull();
    expect(message).toContain('v16.20.0');
    expect(message).toContain('v22');
    expect(message).toContain('TROUBLESHOOTING.md');
  });

  it('defaults to process.version when no argument is given', () => {
    // The test runner itself must satisfy engines.node (>=22), so this is null.
    expect(checkNodeVersion()).toBeNull();
  });
});
