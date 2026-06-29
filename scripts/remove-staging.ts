#!/usr/bin/env npx tsx
/**
 * remove-staging.ts — Strip all staging-environment support from the codebase.
 *
 * Run once on the chore/prepare-for-public-release branch before pushing to
 * the public GitHub repo. The staging region is an NR-internal convenience;
 * external users cannot obtain staging credentials.
 *
 * After running: npm run build && npm test to verify.
 *
 * This script itself is excluded from the public repo (git rm'd in pre-flight).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
let errors = 0;
let filesChanged = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function path(rel: string): string {
  return resolve(root, rel);
}

function read(rel: string): string {
  return readFileSync(path(rel), 'utf-8');
}

function write(rel: string, content: string): void {
  writeFileSync(path(rel), content, 'utf-8');
}

/**
 * Apply a single replacement. Fails loudly if the `from` string is not found
 * exactly `expectedCount` times (default: 1). Pass `expectedCount: -1` to
 * allow any number of replacements (useful for bulk fixture cleanup).
 */
function replace(
  rel: string,
  content: string,
  from: string,
  to: string,
  expectedCount = 1,
): string {
  const occurrences = content.split(from).length - 1;
  if (expectedCount !== -1 && occurrences !== expectedCount) {
    console.error(
      `  ✗  ${rel}: expected ${expectedCount} occurrence(s) of pattern, found ${occurrences}:\n     ${from.slice(0, 80)}`,
    );
    errors++;
    return content;
  }
  if (occurrences === 0) return content;
  return to === '__DELETE_LINE__'
    ? content
        .split('\n')
        .filter((line) => !line.includes(from))
        .join('\n')
    : content.split(from).join(to);
}

function applyChanges(
  rel: string,
  changes: Array<{ from: string; to: string; count?: number }>,
): void {
  let content = read(rel);
  const original = content;
  for (const { from, to, count = 1 } of changes) {
    content = replace(rel, content, from, to, count);
  }
  if (content !== original) {
    write(rel, content);
    console.log(`  ✓  ${rel}`);
    filesChanged++;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

console.log('\nRemoving staging support for public release...\n');

// ── README.md ────────────────────────────────────────────────────────────────
applyChanges('README.md', [
  {
    from: ` • [**Internal**](docs/INTERNAL_USAGE.md)`,
    to: '',
  },
]);

// ── src/shared/transport/http-client.ts ─────────────────────────────────────
// One-time edit: sync-shared.ts is excluded from public repo, so this file
// will not be overwritten by a future sync on the public side.
applyChanges('src/shared/transport/http-client.ts', [
  // Remove staging from Region JSDoc
  {
    from: ' * - `staging` — New Relic staging environment (staging-api.newrelic.com)\n',
    to: '',
  },
  // Remove staging from Region type
  {
    from: `export type Region = 'us' | 'eu' | 'gov' | 'staging';`,
    to: `export type Region = 'us' | 'eu' | 'gov';`,
  },
  // Remove staging keyword branch in resolveRegion
  {
    from: `      if (host === 'staging') return 'staging';\n`,
    to: '',
  },
  // Remove staging HOST_MAP entry (multiline)
  {
    from: `  staging: {
    events: 'staging-insights-collector.newrelic.com',
    metric: 'staging-metric-api.newrelic.com',
    log: 'staging-log-api.newrelic.com',
  },\n`,
    to: '',
  },
  // Remove the doc paragraph that mentions the staging keyword form
  {
    from: ` *\n * Note: setting collectorHost to a full NR hostname like\n * \`staging-insights-collector.newrelic.com\` will use that host literally for\n * all three APIs — which only works for events. Use the \`'staging'\` keyword\n * form to route all three APIs to NR's per-service staging hostnames.\n`,
    to: ' *\n',
  },
  // Remove 'staging' from the region keyword list in the JSDoc
  {
    from: ` * (one of 'us', 'eu', 'gov', 'staging') — \`resolveRegion\` maps it to the`,
    to: ` * (one of 'us', 'eu', 'gov') — \`resolveRegion\` maps it to the`,
  },
  // Update §5.23 audit comment to remove staging-specific example
  {
    from: ` * renames a host (e.g. the audit's "if NR ever renames staging hosts"\n * concern under §5.23).`,
    to: ` * renames a host (§5.23).`,
  },
]);

// ── src/index.ts ─────────────────────────────────────────────────────────────
applyChanges('src/index.ts', [
  // deploy-dashboards --staging option
  {
    from: `      .option('--staging', 'target the New Relic staging API')\n`,
    to: '',
    count: 2,
  },
  // deploy-dashboards opts.staging
  {
    from: `          staging: opts.staging === true,\n`,
    to: '',
    count: 2,
  },
]);

// ── src/tools/cross-session-tools.ts ────────────────────────────────────────
applyChanges('src/tools/cross-session-tools.ts', [
  {
    from: `  if (collectorHost === 'staging') return 'https://staging-api.newrelic.com/graphql';\n`,
    to: '',
  },
]);

// ── src/install/key-validator.ts ─────────────────────────────────────────────
applyChanges('src/install/key-validator.ts', [
  {
    from: `  staging: 'staging-insights-collector.newrelic.com',\n`,
    to: '',
  },
  {
    from: `  staging: 'https://staging-api.newrelic.com/graphql',\n`,
    to: '',
  },
]);

// ── src/install/setup-wizard.ts ──────────────────────────────────────────────
applyChanges('src/install/setup-wizard.ts', [
  // Remove option 3 from the menu and renumber option 4 → 3
  {
    from: `      print('  3) Staging — staging-api.newrelic.com');\n      print('  4) FedRAMP — api.newrelic.com (FedRAMP/GovCloud)');`,
    to: `      print('  3) FedRAMP — api.newrelic.com (FedRAMP/GovCloud)');`,
  },
  // Remove staging branch and update FedRAMP to option 3
  {
    from: `            : envRaw === '3' || envRaw === 'staging'
                ? 'staging'
                : envRaw === '4' || envRaw === 'fedramp' || envRaw === 'gov'`,
    to: `            : envRaw === '3' || envRaw === 'fedramp' || envRaw === 'gov'`,
  },
  // Remove --staging from install command generation
  {
    from: `        collectorHost === 'eu' ? ' --eu' : collectorHost === 'staging' ? ' --staging' : ''`,
    to: `        collectorHost === 'eu' ? ' --eu' : ''`,
  },
]);

// ── src/deploy/deploy-dashboards.ts ─────────────────────────────────────────
applyChanges('src/deploy/deploy-dashboards.ts', [
  { from: `  readonly staging: boolean;\n`, to: '' },
  {
    from: `  if (opts.staging) return 'https://staging-api.newrelic.com/graphql';\n`,
    to: '',
  },
  {
    from: `  if (opts.staging && opts.eu) {\n    out.write('Error: --staging and --eu are mutually exclusive.\\n');\n    return 1;\n  }\n`,
    to: '',
  },
  {
    from: `  if (opts.staging) {\n    out.write('Targeting staging API: https://staging-api.newrelic.com/graphql\\n');\n  } else if (opts.eu) {`,
    to: `  if (opts.eu) {`,
  },
]);

// ── src/deploy/deploy-alerts.ts ──────────────────────────────────────────────
applyChanges('src/deploy/deploy-alerts.ts', [
  { from: `  readonly staging: boolean;\n`, to: '' },
  {
    from: `  if (opts.staging) return 'https://staging-api.newrelic.com/graphql';\n`,
    to: '',
  },
  {
    from: `  if (opts.staging && opts.eu) {\n    out.write('Error: --staging and --eu are mutually exclusive.\\n');\n    return 1;\n  }\n\n`,
    to: '\n',
  },
  {
    from: `  if (opts.staging) {\n    out.write('Targeting staging API: https://staging-api.newrelic.com/graphql\\n');\n  } else if (opts.eu) {`,
    to: `  if (opts.eu) {`,
  },
]);

// ── scripts/backfill-sessions.ts ─────────────────────────────────────────────
applyChanges('scripts/backfill-sessions.ts', [
  {
    from: ` *     npx tsx scripts/backfill-sessions.ts --developer <name> [--days 90] [--dry-run] [--staging]\n`,
    to: ` *     npx tsx scripts/backfill-sessions.ts --developer <name> [--days 90] [--dry-run]\n`,
  },
  // Change module-level `let` to `const` since it won't be reassigned
  {
    from: `let NERDGRAPH_URL = 'https://api.newrelic.com/graphql';`,
    to: `const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';`,
  },
  // Remove the staging flag check and conditional URL override in main()
  {
    from: `  const staging = args.includes('--staging');\n\n  if (staging) {\n    NERDGRAPH_URL = 'https://staging-api.newrelic.com/graphql';\n    process.stdout.write('Targeting staging API: https://staging-api.newrelic.com/graphql\\n');\n  }\n\n`,
    to: '\n',
  },
]);

// ── src/install/key-validator.test.ts ────────────────────────────────────────
applyChanges('src/install/key-validator.test.ts', [
  {
    from: `  it('returns staging endpoint', () => {\n    expect(getEventsApiUrl('12345', 'staging')).toBe(\n      'https://staging-insights-collector.newrelic.com/v1/accounts/12345/events',\n    );\n  });\n\n`,
    to: '',
  },
  {
    from: `  it('returns staging endpoint', () => {\n    expect(getNerdgraphUrl('staging')).toBe('https://staging-api.newrelic.com/graphql');\n  });\n`,
    to: '',
  },
]);

// ── src/install/setup-wizard.test.ts ─────────────────────────────────────────
applyChanges('src/install/setup-wizard.test.ts', [
  // Remove "writes collectorHost staging when provided" test
  {
    from: `  it('writes collectorHost staging when provided', () => {\n    const result = buildConfig({}, { ...base, collectorHost: 'staging' });\n    expect(result.collectorHost).toBe('staging');\n  });\n`,
    to: '',
  },
  // Remove "writes collectorHost staging when staging selected" test
  {
    from: `  it('writes collectorHost staging when staging selected', async () => {\n    answers('cloud', '12345', 'NRLIC-test', 'staging', '', 'tester', '', '', '', 'n');\n\n    await runSetupWizard();\n\n    const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;\n    const written = JSON.parse(writtenJson) as Record<string, unknown>;\n    expect(written.collectorHost).toBe('staging');\n  });\n`,
    to: '',
  },
  // Remove "includes --staging in deploy commands" test
  {
    from: `  it('includes --staging in deploy commands when staging is selected', async () => {\n    answers('cloud', '12345', 'NRLIC-test', 'staging', '', 'tester', '', '', '', 'n');\n\n    await runSetupWizard();\n\n    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');\n    expect(output).toContain('--staging');\n  });\n`,
    to: '',
  },
  // Remove "--staging" assertion and update test name
  {
    from: `  it('does not include --eu or --staging in deploy commands when US is selected', async () => {`,
    to: `  it('does not include --eu in deploy commands when US is selected', async () => {`,
  },
  {
    from: `    expect(output).not.toContain('--staging');\n`,
    to: '',
  },
  // Update fallback test name and comment to not mention staging
  {
    from: `  it('falls back to default env on unrecognized input rather than silently picking staging', async () => {\n    // Typo or garbage input should not silently route to staging`,
    to: `  it('falls back to default env on unrecognized input', async () => {\n    // Typo or garbage input should fall back to the default env`,
  },
  // Fix test that selects 'staging' in answers — change to 'us'
  {
    from: `    answers('cloud', '12345', 'NRLIC-legacykey', 'staging', '', 'tester', '', '', '', 'n');`,
    to: `    answers('cloud', '12345', 'NRLIC-legacykey', 'us', '', 'tester', '', '', '', 'n');`,
  },
]);

// ── src/deploy/deploy-alerts.test.ts ─────────────────────────────────────────
// Remove `staging: false,` from all test fixtures (bulk replace)
applyChanges('src/deploy/deploy-alerts.test.ts', [
  { from: `      staging: false,\n`, to: '', count: -1 },
]);

// ── src/deploy/deploy-dashboards.test.ts ─────────────────────────────────────
applyChanges('src/deploy/deploy-dashboards.test.ts', [
  { from: `      staging: false,\n`, to: '', count: -1 },
  // Delete "rejects --staging + --eu" test in full — staging: true in the fixture
  // would be a TypeScript error once the staging field is removed from the interface.
  {
    from: `  it('rejects --staging + --eu', async () => {\n    process.env.NEW_RELIC_ACCOUNT_ID = '12345';\n    process.env.NEW_RELIC_API_KEY = 'NRAK-test';\n    const out = new CapturedStdout();\n    const code = await runDeployDashboards({\n      all: false,\n      update: false,\n      teardown: false,\n      print: false,\n      staging: true,\n      eu: true,\n      developer: null,\n      file: 'sample.json',\n      dataDir,\n      stdout: out,\n    });\n    expect(code).toBe(1);\n    expect(out.text()).toContain('mutually exclusive');\n  });\n`,
    to: '',
  },
  // Delete "--staging targets staging API URL" test in full — same reason.
  {
    from: `  it('--staging targets staging API URL', async () => {\n    process.env.NEW_RELIC_ACCOUNT_ID = '12345';\n    process.env.NEW_RELIC_API_KEY = 'NRAK-test';\n    const { fetch: fetchImpl, calls } = makeFetchMock([\n      { data: { dashboardCreate: { entityResult: { guid: 'G', name: 'Test Dashboard' } } } },\n    ]);\n    const out = new CapturedStdout();\n    await runDeployDashboards({\n      all: false,\n      update: false,\n      teardown: false,\n      print: false,\n      staging: true,\n      eu: false,\n      developer: null,\n      file: 'sample.json',\n      dataDir,\n      fetchImpl,\n      stdout: out,\n    });\n    expect(calls[0].url).toBe('https://staging-api.newrelic.com/graphql');\n  });\n`,
    to: '',
  },
]);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (errors > 0) {
  console.error(`${errors} replacement(s) failed — check patterns above and re-run.`);
  console.error('Do NOT run build/test until all replacements succeed.\n');
  process.exit(1);
} else {
  console.log(`${filesChanged} file(s) updated. Next steps:`);
  console.log('  npm run build   # must pass with 0 errors');
  console.log('  npm test        # must pass with 0 failures\n');
}
