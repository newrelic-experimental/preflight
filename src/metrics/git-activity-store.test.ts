import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ActivityStore, type KeyedRecord } from './git-activity-store.js';

interface TestRecord extends KeyedRecord {
  readonly label: string;
}

function makeRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    recordId: 'record-1',
    timestamp: 1000,
    workspaceKey: 'ws-a',
    label: 'test-label',
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('ActivityStore', () => {
  it('basic ingest and query with records out of timestamp order', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 200, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r3', timestamp: 300, workspaceKey: 'ws-a' }));

    const results = store.query({ since: 0, until: 400 });

    expect(results).toHaveLength(3);
    expect(results[0].timestamp).toBe(100);
    expect(results[1].timestamp).toBe(200);
    expect(results[2].timestamp).toBe(300);
  });

  it('dedup on ingest with same recordId and workspaceKey', () => {
    const store = new ActivityStore<TestRecord>();

    const record = makeRecord({
      recordId: 'r1',
      timestamp: 1000,
      workspaceKey: 'ws-a',
      label: 'first',
    });
    store.ingest(record);
    store.ingest(record);

    const results = store.query({ since: 0, until: 2000 });

    expect(results).toHaveLength(1);
  });

  it('dedup is per-(workspaceKey, recordId) not global recordId', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'x', timestamp: 100, workspaceKey: 'ws-a', label: 'a' }));
    store.ingest(makeRecord({ recordId: 'x', timestamp: 200, workspaceKey: 'ws-b', label: 'b' }));

    const results = store.query({ since: 0, until: 300 });

    expect(results).toHaveLength(2);
    expect(results[0].label).toBe('a');
    expect(results[1].label).toBe('b');
  });

  it('window filtering with since inclusive and until exclusive', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 150, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r3', timestamp: 200, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r4', timestamp: 300, workspaceKey: 'ws-a' }));

    const results = store.query({ since: 150, until: 300 });

    expect(results).toHaveLength(2);
    expect(results[0].timestamp).toBe(150);
    expect(results[1].timestamp).toBe(200);
  });

  it('key filtering with keys parameter', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a', label: 'a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b', label: 'b' }));
    store.ingest(makeRecord({ recordId: 'r3', timestamp: 300, workspaceKey: 'ws-c', label: 'c' }));

    const results = store.query({ since: 0, until: 400, keys: ['ws-a'] });

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('a');
  });

  it('query with no keys parameter returns records from all keys', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a', label: 'a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b', label: 'b' }));

    const results = store.query({ since: 0, until: 300 });

    expect(results).toHaveLength(2);
  });

  it('query with empty keys array returns records from all keys', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a', label: 'a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b', label: 'b' }));

    const results = store.query({ since: 0, until: 300, keys: [] });

    expect(results).toHaveLength(2);
  });

  it('knownKeys returns keys with records at or after since', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b' }));
    store.ingest(makeRecord({ recordId: 'r3', timestamp: 300, workspaceKey: 'ws-c' }));

    const keys = store.knownKeys(150);

    expect(keys).toHaveLength(2);
    expect(keys).toContain('ws-b');
    expect(keys).toContain('ws-c');
  });

  it('knownKeys excludes keys with all records before since', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 50, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b' }));

    const keys = store.knownKeys(100);

    expect(keys).toHaveLength(1);
    expect(keys).toContain('ws-b');
  });

  it('evictBefore removes records before cutoff', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-a' }));

    store.evictBefore(150);

    const results = store.query({ since: 0, until: 300 });

    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe(200);
  });

  it('evictBefore frees the dedup entry for an evicted record even when the bucket survives', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-a' }));

    store.evictBefore(150);

    // r1's timestamp (100) is stale on purpose — this simulates the same
    // recordId recurring after its original record aged out, which must be
    // treated as a fresh record, not silently dropped by a leaked dedup entry.
    store.ingest(makeRecord({ recordId: 'r1', timestamp: 250, workspaceKey: 'ws-a' }));

    const results = store.query({ since: 0, until: 300 });

    expect(results.map((r) => r.timestamp)).toEqual([200, 250]);
  });

  it('evictBefore removes empty buckets and their dedup sets', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a' }));
    store.ingest(makeRecord({ recordId: 'r2', timestamp: 200, workspaceKey: 'ws-b' }));

    store.evictBefore(150);

    const keys = store.knownKeys(0);

    expect(keys).toHaveLength(1);
    expect(keys).toContain('ws-b');
  });

  it('query returns a copy not the internal array', () => {
    const store = new ActivityStore<TestRecord>();

    store.ingest(
      makeRecord({ recordId: 'r1', timestamp: 100, workspaceKey: 'ws-a', label: 'original' }),
    );

    const results1 = store.query({ since: 0, until: 200 });
    expect(results1).toHaveLength(1);

    (results1 as TestRecord[]).push(
      makeRecord({ recordId: 'r-fake', timestamp: 150, workspaceKey: 'ws-a', label: 'mutated' }),
    );

    const results2 = store.query({ since: 0, until: 200 });

    expect(results2).toHaveLength(1);
    expect(results2[0].label).toBe('original');
  });
});
