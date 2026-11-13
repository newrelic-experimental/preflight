import { resolveRecordContent } from './record-content-gate.js';

describe('resolveRecordContent', () => {
  it('returns false when highSecurity is true, regardless of explicitValue', () => {
    expect(resolveRecordContent(true, true)).toBe(false);
    expect(resolveRecordContent(true, false)).toBe(false);
  });

  it('returns explicitValue unchanged when highSecurity is false', () => {
    expect(resolveRecordContent(false, true)).toBe(true);
    expect(resolveRecordContent(false, false)).toBe(false);
  });
});
