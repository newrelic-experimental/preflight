import { win32 } from 'node:path';

// static-handler.ts's containment check now delegates entirely to
// path.relative()/path.isAbsolute() rather than hand-rolled separator
// matching, so there's no callable function of ours left to unit-test in
// isolation for the Windows case. This pins Node's own path.win32 behavior
// for the exact inputs that check relies on, so a future Node behavior
// change here would be caught rather than silently relied upon.
describe('path.win32 containment behavior (pins Node, not our code)', () => {
  it('produces a plain relative path for a child of root', () => {
    const rel = win32.relative('C:\\Users\\dev\\dist', 'C:\\Users\\dev\\dist\\index.html');
    expect(rel.startsWith('..')).toBe(false);
    expect(win32.isAbsolute(rel)).toBe(false);
  });

  it('produces a parent-escaping relative path for a sibling that merely shares a prefix', () => {
    const rel = win32.relative('C:\\Users\\dev\\dist', 'C:\\Users\\dev\\dist-evil\\secret');
    expect(rel.startsWith('..')).toBe(true);
  });
});
