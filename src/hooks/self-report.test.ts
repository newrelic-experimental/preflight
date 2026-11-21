import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SelfReportHookEvent } from '../storage/types.js';
import {
  claimReport,
  pruneSelfReportClaims,
  reportKey,
  SELF_REPORT_CLAIM_MAX_AGE_MS,
} from './self-report.js';

const NOW = Date.UTC(2026, 10, 21, 12);

function makeLine(sessionId: string, reportId: string): SelfReportHookEvent {
  return {
    mode: 'self_report',
    tool: 'nr_observe_report_tokens',
    timestamp: NOW,
    sessionId,
    reportId,
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    platform: 'claude-code',
  };
}

function claimAt(storageDir: string, line: SelfReportHookEvent, mtimeMs: number): string {
  expect(claimReport(storageDir, line)).toBe(true);
  const path = join(storageDir, 'self-reports', line.sessionId, reportKey(line));
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

describe('pruneSelfReportClaims', () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'self-report-claims-'));
  });

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('removes an old claim and the conversation directory it leaves empty', () => {
    const old = makeLine('conv-old', 'report-old-1');
    claimAt(storageDir, old, NOW - SELF_REPORT_CLAIM_MAX_AGE_MS - 1);

    expect(pruneSelfReportClaims(storageDir, NOW)).toBe(1);

    expect(existsSync(join(storageDir, 'self-reports', 'conv-old'))).toBe(false);
    expect(claimReport(storageDir, old)).toBe(true);
  });

  it('keeps a recent claim so a retried hook still cannot write the report twice', () => {
    const old = makeLine('conv-live', 'report-old-1');
    const live = makeLine('conv-live', 'report-live-1');
    claimAt(storageDir, old, NOW - SELF_REPORT_CLAIM_MAX_AGE_MS - 1);
    const livePath = claimAt(storageDir, live, NOW - 1000);

    expect(pruneSelfReportClaims(storageDir, NOW)).toBe(1);

    expect(existsSync(livePath)).toBe(true);
    expect(claimReport(storageDir, live)).toBe(false);
  });

  it('returns 0 when no claim has been written yet', () => {
    expect(pruneSelfReportClaims(storageDir, NOW)).toBe(0);
  });
});
