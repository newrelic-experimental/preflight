/**
 * Decides what to send and makes sure only one process sends it. Several
 * Preflight processes run at once (usually one per assistant session), so
 * each report is claimed by creating a file exclusively before sending.
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAIM_ABANDONED_MS,
  EVENTS,
  RETENTION_MS,
  SUMMARY_GRACE_MS,
  type FeatureName,
} from './constants.js';
import { listPending, summarize, utcDate, type DaySummary } from './counters.js';
import { buildEvent, type EventIdentity, type PropertyValue, type TrackEvent } from './events.js';
import type { UsageReportSender } from './sender.js';
import { ensureDir } from './state.js';

export interface InstallInfo {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly node_major: number;
  readonly adapter: string;
  readonly install_channel: string;
  readonly mode: string;
  readonly hooks_installed: boolean;
}

export interface ReportInputs {
  readonly install: InstallInfo;
  readonly features: Readonly<Record<FeatureName, boolean>>;
}

function claimsDir(dir: string): string {
  return join(dir, 'claims');
}

type ClaimStatus = 'claimed' | 'sent';

/** Exclusive create. Returns false if another process holds or finished this claim. */
function claim(dir: string, key: string, now: number): boolean {
  const cdir = claimsDir(dir);
  ensureDir(cdir);
  const path = join(cdir, key);
  try {
    writeFileSync(path, 'claimed', { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    // Exists. Take it over only if a process claimed it and then vanished.
    try {
      const status = readFileSync(path, 'utf-8').trim() as ClaimStatus;
      if (status === 'claimed' && now - statSync(path).mtimeMs > CLAIM_ABANDONED_MS) {
        rmSync(path, { force: true });
        writeFileSync(path, 'claimed', { flag: 'wx', mode: 0o600 });
        return true;
      }
    } catch {
      // lost a race; someone else has it
    }
    return false;
  }
}

function markSent(dir: string, key: string, sender: UsageReportSender): void {
  // A debug pass sent nothing, so the real report still has to go out.
  if (sender.debug) release(dir, key);
  else writeFileSync(join(claimsDir(dir), key), 'sent', { mode: 0o600 });
}

function release(dir: string, key: string): void {
  rmSync(join(claimsDir(dir), key), { force: true });
}

export function buildStartReport(inputs: ReportInputs, identity: EventIdentity): TrackEvent[] {
  const install = buildEvent(
    EVENTS.install,
    Object.fromEntries(
      Object.entries(inputs.install).map(([key, value]) => [`preflight_${key}`, value]),
    ) as Record<string, PropertyValue>,
    identity,
  );
  const features = Object.entries(inputs.features).map(([feature, enabled]) =>
    buildEvent(
      EVENTS.feature,
      { preflight_feature: feature, preflight_feature_enabled: enabled },
      identity,
    ),
  );
  return [install, ...features];
}

export function buildSummary(summary: DaySummary, identity: EventIdentity): TrackEvent[] {
  const date = summary.usage_date;
  const events: TrackEvent[] = [
    buildEvent(
      EVENTS.usage,
      { preflight_usage_date: date, preflight_sessions_observed: summary.sessions_observed },
      identity,
    ),
  ];
  if (summary.page_loads > 0 || summary.live_connections > 0) {
    events.push(
      buildEvent(
        EVENTS.dashboard,
        {
          preflight_usage_date: date,
          preflight_page_loads: summary.page_loads,
          preflight_live_connections: summary.live_connections,
          preflight_open_on_start: summary.open_on_start,
        },
        identity,
      ),
    );
  }
  for (const [toolName, callCount] of Object.entries(summary.tools)) {
    events.push(
      buildEvent(
        EVENTS.tool,
        {
          preflight_usage_date: date,
          preflight_tool_name: toolName,
          preflight_call_count: callCount,
        },
        identity,
      ),
    );
  }
  return events;
}

/** Delete pending files and claims older than the retention window. */
export function sweep(dir: string, now: number): void {
  for (const sub of ['pending', 'claims']) {
    const sdir = join(dir, sub);
    let names: string[];
    try {
      names = readdirSync(sdir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(sdir, name);
      try {
        if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
      } catch {
        // already gone
      }
    }
  }
}

export interface TickOptions {
  readonly now?: Date;
}

export interface TickResult {
  readonly startReportSent: boolean;
  readonly summariesSent: readonly string[];
}

/** One reporting pass: today's start report, then any completed day not yet sent. */
export async function runReportTick(
  dir: string,
  sender: UsageReportSender,
  inputs: ReportInputs,
  identity: EventIdentity,
  opts: TickOptions = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  sweep(dir, nowMs);
  const today = utcDate(now);

  let startReportSent = false;
  const startKey = `start-${today}`;
  if (sender.available && claim(dir, startKey, nowMs)) {
    if (await sender.sendAll(buildStartReport(inputs, identity))) {
      markSent(dir, startKey, sender);
      startReportSent = true;
    } else {
      release(dir, startKey);
    }
  }

  const summariesSent: string[] = [];
  const pending = listPending(dir);
  const dates = [...new Set(pending.map((p) => p.counts.usage_date))].sort();
  for (const date of dates) {
    const dayEnd = Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60_000;
    if (nowMs < dayEnd + SUMMARY_GRACE_MS) continue;
    const key = `summary-${date}`;
    if (!sender.available || !claim(dir, key, nowMs)) continue;
    const files = pending.filter((p) => p.counts.usage_date === date);
    if (await sender.sendAll(buildSummary(summarize(date, files), identity))) {
      markSent(dir, key, sender);
      if (!sender.debug) for (const f of files) rmSync(f.file, { force: true });
      summariesSent.push(date);
    } else {
      release(dir, key);
    }
  }
  return { startReportSent, summariesSent };
}
