/**
 * Per-process daily counts. Each process owns one pending file per UTC day,
 * `pending/<usage_date>-<session_id>.json`, and replaces it whole on flush.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDir, writeFileAtomic } from './state.js';

export interface DayCounts {
  readonly usage_date: string;
  readonly session_id: string;
  readonly sessions_observed: number;
  readonly page_loads: number;
  readonly live_connections: number;
  readonly open_on_start: boolean;
  readonly tools: Readonly<Record<string, number>>;
}

interface MutableDay {
  page_loads: number;
  live_connections: number;
  tools: Record<string, number>;
  dirty: boolean;
}

export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function pendingDir(dir: string): string {
  return join(dir, 'pending');
}

const PENDING_FILE = /^(\d{4}-\d{2}-\d{2})-([0-9a-f-]{36})\.json$/;

export class UsageCounters {
  private readonly days = new Map<string, MutableDay>();

  constructor(
    private readonly dir: string,
    private readonly sessionId: string,
    private readonly openOnStart: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): MutableDay {
    const key = utcDate(this.now());
    let day = this.days.get(key);
    if (!day) {
      day = { page_loads: 0, live_connections: 0, tools: {}, dirty: true };
      this.days.set(key, day);
    }
    return day;
  }

  /** Marks this process active today. Called on start and on every recorded action. */
  touch(): void {
    this.today();
  }

  recordToolCall(toolName: string): void {
    const day = this.today();
    day.tools[toolName] = (day.tools[toolName] ?? 0) + 1;
    day.dirty = true;
  }

  recordPageLoad(): void {
    const day = this.today();
    day.page_loads++;
    day.dirty = true;
  }

  recordLiveConnection(): void {
    const day = this.today();
    day.live_connections++;
    day.dirty = true;
  }

  /** Forget everything in memory (consent withdrawn, or just granted). */
  clear(): void {
    this.days.clear();
  }

  flush(): void {
    const dir = pendingDir(this.dir);
    for (const [date, day] of this.days) {
      if (!day.dirty) continue;
      const counts: DayCounts = {
        usage_date: date,
        session_id: this.sessionId,
        sessions_observed: 1,
        page_loads: day.page_loads,
        live_connections: day.live_connections,
        open_on_start: this.openOnStart,
        tools: day.tools,
      };
      ensureDir(dir);
      writeFileAtomic(join(dir, `${date}-${this.sessionId}.json`), JSON.stringify(counts) + '\n');
      day.dirty = false;
    }
    // Days other than today are final once written.
    const today = utcDate(this.now());
    for (const [date, day] of this.days) {
      if (date !== today && !day.dirty) this.days.delete(date);
    }
  }
}

export interface PendingFile {
  readonly file: string;
  readonly counts: DayCounts;
}

export function listPending(dir: string): PendingFile[] {
  const pdir = pendingDir(dir);
  let names: string[];
  try {
    names = readdirSync(pdir);
  } catch {
    return [];
  }
  const out: PendingFile[] = [];
  for (const name of names) {
    if (!PENDING_FILE.test(name)) continue;
    try {
      const counts = JSON.parse(readFileSync(join(pdir, name), 'utf-8')) as DayCounts;
      out.push({ file: join(pdir, name), counts });
    } catch {
      // half-written or corrupt; the retention sweep removes it
    }
  }
  return out;
}

export interface DaySummary {
  readonly usage_date: string;
  readonly sessions_observed: number;
  readonly page_loads: number;
  readonly live_connections: number;
  readonly open_on_start: boolean;
  readonly tools: Readonly<Record<string, number>>;
}

export function summarize(date: string, files: readonly PendingFile[]): DaySummary {
  const tools: Record<string, number> = {};
  let sessions = 0;
  let pageLoads = 0;
  let live = 0;
  let openOnStart = false;
  for (const { counts } of files) {
    if (counts.usage_date !== date) continue;
    sessions += counts.sessions_observed;
    pageLoads += counts.page_loads;
    live += counts.live_connections;
    openOnStart ||= counts.open_on_start;
    for (const [k, v] of Object.entries(counts.tools)) tools[k] = (tools[k] ?? 0) + v;
  }
  return {
    usage_date: date,
    sessions_observed: sessions,
    page_loads: pageLoads,
    live_connections: live,
    open_on_start: openOnStart,
    tools,
  };
}
