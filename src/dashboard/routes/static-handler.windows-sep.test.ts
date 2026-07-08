import { isWithinRoot } from './static-handler.js';

// static-handler.ts resolves paths with node:path's `resolve`/`join`, which on
// Windows produce backslash-joined paths — a '/'-only containment check
// never matches them. `platformSep` is passed explicitly here so the Windows
// branch is exercised deterministically regardless of the OS actually
// running this test.
describe('isWithinRoot — Windows separator', () => {
  it('accepts a child path joined with backslashes', () => {
    expect(isWithinRoot('C:\\Users\\dev\\dist', 'C:\\Users\\dev\\dist\\index.html', '\\')).toBe(
      true,
    );
  });

  it('rejects a sibling path that merely shares a prefix', () => {
    expect(isWithinRoot('C:\\Users\\dev\\dist', 'C:\\Users\\dev\\dist-evil\\secret', '\\')).toBe(
      false,
    );
  });

  it('still accepts POSIX-style child paths using the default separator', () => {
    expect(isWithinRoot('/app/dist', '/app/dist/index.html')).toBe(true);
  });

  it('still rejects POSIX-style sibling paths using the default separator', () => {
    expect(isWithinRoot('/app/dist', '/app/dist-evil/secret')).toBe(false);
  });
});
