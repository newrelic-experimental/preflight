export interface CallUsage {
  readonly calls: number;
  readonly tokens: number;
}

/** Adds `delta` to the entry for `model`; extra fields on `delta` replace the prior ones. */
export function addCallUsage<T extends CallUsage>(
  map: Map<string, T>,
  model: string,
  delta: T,
): void {
  const prior = map.get(model);
  map.set(model, {
    ...delta,
    calls: (prior?.calls ?? 0) + delta.calls,
    tokens: (prior?.tokens ?? 0) + delta.tokens,
  });
}

/** Sums records of different sessions into `target`. */
export function sumCallUsageInto<T extends CallUsage>(
  target: Record<string, T>,
  source: Readonly<Record<string, T>> | undefined,
): void {
  for (const [model, v] of Object.entries(source ?? {})) {
    const prior = target[model];
    target[model] = {
      ...v,
      calls: (prior?.calls ?? 0) + v.calls,
      tokens: (prior?.tokens ?? 0) + v.tokens,
    };
  }
}

/**
 * Merges two snapshots of one session's counters. Counters only grow, so the
 * larger value per model is the later snapshot's; extra fields come from `b`.
 */
export function mergeCallUsageMax<T extends CallUsage>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (a === undefined && b === undefined) return undefined;
  const out: Record<string, T> = { ...a };
  for (const [model, v] of Object.entries(b ?? {})) {
    const prior = out[model];
    out[model] = {
      ...v,
      calls: Math.max(prior?.calls ?? 0, v.calls),
      tokens: Math.max(prior?.tokens ?? 0, v.tokens),
    };
  }
  return out;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parses an untrusted persisted record. Entries failing validation are dropped;
 * `parseExtra` returns the entry's extra fields, or null to drop the entry.
 */
export function parseCallUsageRecord<T extends CallUsage>(
  value: unknown,
  parseExtra: (entry: Record<string, unknown>) => Omit<T, keyof CallUsage> | null,
): Record<string, T> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, T> = {};
  for (const [model, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
    const entry = v as Record<string, unknown>;
    if (!isCount(entry.calls) || !isCount(entry.tokens)) continue;
    const extra = parseExtra(entry);
    if (extra === null) continue;
    out[model] = { ...extra, calls: entry.calls, tokens: entry.tokens } as T;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
