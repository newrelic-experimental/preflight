import { resolve } from 'node:path';
import { isMainModule, resolveNerdgraphUrl } from '../scripts/backfill-sessions.js';
import { stagingHost } from '../src/shared/transport/http-client.js';

describe('resolveNerdgraphUrl', () => {
  it('returns the production NerdGraph URL by default', () => {
    expect(resolveNerdgraphUrl(false)).toBe('https://api.newrelic.com/graphql');
  });

  it('returns the staging NerdGraph URL when staging is true', () => {
    expect(resolveNerdgraphUrl(true)).toBe(`https://${stagingHost('api')}/graphql`);
  });
});

describe('isMainModule', () => {
  const originalArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('returns false when argv[1] is undefined', () => {
    process.argv[1] = undefined as unknown as string;
    expect(isMainModule()).toBe(false);
  });

  it('returns false when argv[1] points to a nonexistent path', () => {
    process.argv[1] = '/nonexistent/path/backfill-sessions.ts';
    expect(isMainModule()).toBe(false);
  });

  it('returns false when argv[1] resolves to a different file', () => {
    process.argv[1] = resolve(process.cwd(), 'test', 'backfill-sessions.test.ts');
    expect(isMainModule()).toBe(false);
  });

  it('returns true when argv[1] resolves to scripts/backfill-sessions.ts', () => {
    process.argv[1] = resolve(process.cwd(), 'scripts', 'backfill-sessions.ts');
    expect(isMainModule()).toBe(true);
  });
});
