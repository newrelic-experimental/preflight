/**
 * What `preflight usage-reports show` prints and the dashboard's Settings page
 * shows: the next start report, the queued daily summaries, and recent sends.
 */

import { existsSync, readFileSync } from 'node:fs';

import { FIELD_LIST_VERSION } from './constants.js';
import { listPending, summarize, utcDate } from './counters.js';
import type { TrackEvent } from './events.js';
import { buildStartReport, buildSummary, type ReportInputs } from './reporter.js';
import { readConsent, readInstallId, sentLogPath } from './state.js';

export interface QueuedDay {
  readonly date: string;
  /** Today is still counting; its summary goes out after the UTC day ends. */
  readonly today: boolean;
  readonly events: readonly TrackEvent[];
}

export interface SentEntry {
  readonly sentAt: string;
  readonly event: TrackEvent;
}

export interface UsageReportsPreview {
  readonly start: readonly TrackEvent[];
  readonly queued: readonly QueuedDay[];
  /** The most recent sends, newest last. */
  readonly sent: readonly SentEntry[];
  readonly sentTotal: number;
}

const SENT_SHOWN = 50;

export function buildPreview(dir: string, inputs: ReportInputs): UsageReportsPreview {
  const identity = {
    installId: readInstallId(dir) ?? '<created when usage reports are turned on>',
    sessionId: '<random per Preflight process>',
    fieldListVersion: readConsent(dir).fieldListVersion ?? FIELD_LIST_VERSION,
  };
  const pending = listPending(dir);
  const today = utcDate();
  const dates = [...new Set(pending.map((p) => p.counts.usage_date))].sort();
  return {
    start: buildStartReport(inputs, identity),
    queued: dates.map((date) => ({
      date,
      today: date === today,
      events: buildSummary(summarize(date, pending), identity),
    })),
    ...readSent(dir),
  };
}

function readSent(dir: string): Pick<UsageReportsPreview, 'sent' | 'sentTotal'> {
  const log = sentLogPath(dir);
  if (!existsSync(log)) return { sent: [], sentTotal: 0 };
  const lines = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  const sent: SentEntry[] = [];
  for (const line of lines.slice(-SENT_SHOWN)) {
    try {
      sent.push(JSON.parse(line) as SentEntry);
    } catch {
      // a line cut short by the log trim
    }
  }
  return { sent, sentTotal: lines.length };
}
