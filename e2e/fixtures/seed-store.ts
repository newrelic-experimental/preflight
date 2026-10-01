// Seeds a storage directory for the seeded e2e server. playwright.config.ts runs this as
// the first half of that server's webServer command, so it runs once per test run, in the
// process that owns the storage path, before the server first reads it.
//
// Usage: tsx e2e/fixtures/seed-store.ts <storage-dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFixtureSession, FIXTURE_SESSION_ID } from './session-fixture.js';

const storageDir = process.argv[2];
if (!storageDir) {
  console.error('usage: seed-store.ts <storage-dir>');
  process.exit(1);
}

const session = buildFixtureSession(Date.now());
const sessionsDir = join(storageDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
// SessionStore names files YYYY-MM-DD_<sessionId>.json after the UTC start date.
const date = new Date(session.startTime).toISOString().slice(0, 10);
writeFileSync(
  join(sessionsDir, `${date}_${FIXTURE_SESSION_ID}.json`),
  JSON.stringify(session, null, 2) + '\n',
  { mode: 0o600 },
);
