import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { TierLocalWriter } from './tier-local-writer.js';
import type { NrEventData } from '../shared/index.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tmpDir = mkdtempSync(resolve(tmpdir(), 'tier-local-writer-'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides?: Partial<NrEventData>): NrEventData {
  return {
    eventType: 'AiCodingTask',
    event_version: 1,
    timestamp: 1_700_000_000_000,
    developer: 'test-dev',
    app_name: 'test-app',
    ...overrides,
  };
}

describe('TierLocalWriter', () => {
  it('appends one JSON object per line, one file per UTC day', () => {
    const dir = resolve(tmpDir, 'org');
    const writer = new TierLocalWriter({ tierName: 'org', path: dir });

    writer.addEvent(makeEvent({ task_id: 'task-1' }));
    writer.addEvent(makeEvent({ task_id: 'task-2' }));

    const filePath = writer.getEventFilePath(1_700_000_000_000);
    expect(filePath).toBe(resolve(dir, 'events-2023-11-14.jsonl'));

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).task_id).toBe('task-1');
    expect(JSON.parse(lines[1]).task_id).toBe('task-2');
    expect(JSON.parse(lines[1]).eventType).toBe('AiCodingTask');
  });

  it('creates the tier directory with mode 0o700', () => {
    const dir = resolve(tmpDir, 'nested', 'org');
    const writer = new TierLocalWriter({ tierName: 'org', path: dir });

    writer.addEvent(makeEvent());

    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('writes the JSONL file with mode 0o600', () => {
    const dir = resolve(tmpDir, 'org');
    const writer = new TierLocalWriter({ tierName: 'org', path: dir });

    writer.addEvent(makeEvent());

    expect(statSync(writer.getEventFilePath(1_700_000_000_000)).mode & 0o777).toBe(0o600);
  });

  it('does not touch the filesystem until the first addEvent()', () => {
    const dir = resolve(tmpDir, 'lazy');
    new TierLocalWriter({ tierName: 'lazy', path: dir });
    expect(existsSync(dir)).toBe(false);
  });

  it('buckets events into separate files by their own timestamp day', () => {
    const dir = resolve(tmpDir, 'org');
    const writer = new TierLocalWriter({ tierName: 'org', path: dir });

    writer.addEvent(makeEvent({ timestamp: 1_700_000_000_000 })); // 2023-11-14
    writer.addEvent(makeEvent({ timestamp: 1_700_100_000_000 })); // 2023-11-16

    expect(existsSync(resolve(dir, 'events-2023-11-14.jsonl'))).toBe(true);
    expect(existsSync(resolve(dir, 'events-2023-11-16.jsonl'))).toBe(true);
  });

  it('falls back to now() when the event carries no numeric timestamp', () => {
    const dir = resolve(tmpDir, 'org');
    const writer = new TierLocalWriter({ tierName: 'org', path: dir });

    writer.addEvent({ eventType: 'AiCodingTask', timestamp: 'not-a-number' });

    expect(writer.getStats().writes).toBe(1);
    expect(existsSync(writer.getEventFilePath(Date.now()))).toBe(true);
  });

  it('logs a warning and counts a failure instead of throwing when the path is unwritable', () => {
    // A regular file where the tier directory should be — mkdir fails.
    const blocker = resolve(tmpDir, 'blocked');
    writeFileSync(blocker, 'not-a-directory', { mode: 0o600 });
    const writer = new TierLocalWriter({ tierName: 'org', path: blocker });

    expect(() => writer.addEvent(makeEvent())).not.toThrow();
    expect(writer.getStats().failures).toBe(1);
    expect(writer.getStats().writes).toBe(0);

    const calls = stderrSpy.mock.calls as unknown[][];
    const written = calls.map((call) => JSON.stringify(call[0])).join('\n');
    expect(written).toContain('org');
  });

  it('tracks successful write count', () => {
    const writer = new TierLocalWriter({ tierName: 'org', path: resolve(tmpDir, 'org') });
    writer.addEvent(makeEvent());
    writer.addEvent(makeEvent());
    writer.addEvent(makeEvent());
    expect(writer.getStats()).toEqual({ writes: 3, failures: 0 });
  });
});
