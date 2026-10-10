import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '..', 'scripts', 'changelog-entry.awk');

function runAwk(part: 'entry' | 'rest', version: string, changelog: string): string {
  return execFileSync('awk', ['-f', script], {
    input: changelog,
    encoding: 'utf8',
    env: { ...process.env, PART: part, VERSION: version },
  });
}

const INTRO = '# Changelog\n\nAll notable changes to this project are documented in this file.\n\n';
const RELEASED = '## 1.63.1 - 2026-10-08\n\n### Fixed\n\n- An older fix.\n';

/** CHANGELOG.md before the release: the intro, then the released entries. */
const BEFORE = INTRO + RELEASED;

/**
 * The same file after `npm run version-packages`: `changeset version` puts the new section
 * above the first release heading, followed by a blank line, and `sync` dates its heading.
 */
const AFTER =
  INTRO +
  '## 1.64.0 - 2026-10-10\n\n### Patch Changes\n\n- A fix.\n\n  More about it.\n\n' +
  RELEASED;

describe('changelog-entry.awk', () => {
  it("prints the new entry's body without its heading or the blank line after it", () => {
    expect(runAwk('entry', '1.64.0', AFTER)).toBe(
      '### Patch Changes\n\n- A fix.\n\n  More about it.\n\n',
    );
  });

  it('prints the oldest entry through the end of the file', () => {
    expect(runAwk('entry', '1.63.1', AFTER)).toBe('### Fixed\n\n- An older fix.\n');
  });

  it('prints nothing for a version with no entry', () => {
    expect(runAwk('entry', '9.9.9', AFTER)).toBe('');
  });

  it('gives back the CHANGELOG the release started from once the new entry is removed', () => {
    expect(runAwk('rest', '1.64.0', AFTER)).toBe(BEFORE);
  });

  it('keeps any other edit, so the release PR check sees it', () => {
    const rewritten = AFTER.replace('- An older fix.', '- A rewritten fix.');
    expect(runAwk('rest', '1.64.0', rewritten)).not.toBe(BEFORE);
  });

  it('compares the version as written, without expanding backslash escapes', () => {
    const odd = '## 1\\n2 - 2026-10-10\n\n- Odd.\n';
    expect(runAwk('entry', '1\\n2', odd)).toBe('- Odd.\n');
  });
});
