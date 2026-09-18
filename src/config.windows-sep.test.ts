import { win32 } from 'node:path';

// validateRulesPath's containment check (src/config.ts) delegates entirely to
// path.relative()/isAbsolute() rather than hand-rolled separator matching —
// see static-handler.windows-sep.test.ts for the identical rationale.
// This pins Node's own path.win32 behavior for the exact shapes that check
// relies on, so a future Node behavior change here would be caught rather
// than silently relied upon.
describe('path.win32 containment behavior for alerts.rulesPath (pins Node, not our code)', () => {
  it('accepts the default rules path under storagePath', () => {
    const storageResolved = win32.resolve('C:\\Users\\dev\\.newrelic-preflight');
    const resolved = win32.resolve(storageResolved, 'alerts', 'rules.json');
    const rel = win32.relative(storageResolved, resolved);
    expect(rel.startsWith('..')).toBe(false);
    expect(win32.isAbsolute(rel)).toBe(false);
  });

  it('accepts a custom rules path nested under storagePath', () => {
    const storageResolved = win32.resolve('C:\\Users\\dev\\.newrelic-preflight');
    const resolved = win32.resolve(storageResolved, 'custom', 'my-rules.json');
    const rel = win32.relative(storageResolved, resolved);
    expect(rel.startsWith('..')).toBe(false);
    expect(win32.isAbsolute(rel)).toBe(false);
  });

  it('rejects a sibling directory that merely shares a prefix', () => {
    const storageResolved = win32.resolve('C:\\Users\\dev\\.newrelic-preflight');
    const resolved = win32.resolve('C:\\Users\\dev\\.newrelic-preflight-evil', 'rules.json');
    const rel = win32.relative(storageResolved, resolved);
    expect(rel.startsWith('..')).toBe(true);
  });
});
