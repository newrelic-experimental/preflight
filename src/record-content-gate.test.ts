import { describe, it, expect } from '@jest/globals';
import { resolveRecordContent } from './record-content-gate.js';

describe('resolveRecordContent', () => {
  it('forces false when highSecurity is true, regardless of the explicit value', () => {
    expect(resolveRecordContent(true, true)).toBe(false);
  });

  it('returns the explicit value when highSecurity is false', () => {
    expect(resolveRecordContent(false, true)).toBe(true);
    expect(resolveRecordContent(false, false)).toBe(false);
  });
});
