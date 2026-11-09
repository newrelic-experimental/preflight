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

/** Call usage per local-day key, then per model: `{ [dayKey]: { [model]: usage } }`. */
export type CallUsageByDay<T extends CallUsage> = Record<string, Record<string, T>>;

/** `prior` minus `taken`, or null once no calls remain. Tokens clamp at zero. */
function takeCallUsage<T extends CallUsage>(prior: T, taken: CallUsage): T | null {
  const calls = prior.calls - taken.calls;
  if (calls <= 0) return null;
  return { ...prior, calls, tokens: Math.max(0, prior.tokens - taken.tokens) };
}

function subtractFromMap<T extends CallUsage>(
  target: Map<string, T>,
  taken: ReadonlyMap<string, T>,
): void {
  for (const [model, usage] of taken) {
    const prior = target.get(model);
    if (prior === undefined) continue;
    const rest = takeCallUsage(prior, usage);
    if (rest === null) target.delete(model);
    else target.set(model, rest);
  }
}

/**
 * Call usage of one session, kept per model and per local day. The session
 * totals and the day buckets can differ: a late arrival counts in the totals
 * only, the same way its cost skips the day buckets.
 */
export class CallUsageBook<T extends CallUsage> {
  private readonly models = new Map<string, T>();
  private readonly days = new Map<string, Map<string, T>>();

  /** `dayKey` is null for a call that skips the day buckets. */
  add(model: string, dayKey: string | null, delta: T): void {
    addCallUsage(this.models, model, delta);
    if (dayKey !== null) this.addToDay(dayKey, model, delta);
  }

  /**
   * Restores persisted records. A checkpoint with no day buckets (written before
   * they existed) books its whole count to `fallbackDayKey`, so a resumed session
   * keeps showing its count rather than dropping it.
   */
  addRecords(
    byModel: Readonly<Record<string, T>> | undefined,
    byDay: Readonly<CallUsageByDay<T>> | undefined,
    fallbackDayKey: string,
  ): void {
    for (const [model, usage] of Object.entries(byModel ?? {}))
      addCallUsage(this.models, model, usage);
    const dayRecords = byDay ?? { [fallbackDayKey]: byModel ?? {} };
    for (const [dayKey, perModel] of Object.entries(dayRecords)) {
      for (const [model, usage] of Object.entries(perModel)) this.addToDay(dayKey, model, usage);
    }
  }

  /** Takes `other`'s calls back out of the totals and out of the same day buckets. */
  subtract(other: CallUsageBook<T>): void {
    subtractFromMap(this.models, other.models);
    for (const [dayKey, perModel] of other.days) {
      const day = this.days.get(dayKey);
      if (day === undefined) continue;
      subtractFromMap(day, perModel);
      if (day.size === 0) this.days.delete(dayKey);
    }
  }

  clear(): void {
    this.models.clear();
    this.days.clear();
  }

  byModel(): Record<string, T> {
    return Object.fromEntries(this.models);
  }

  byDay(): CallUsageByDay<T> {
    return Object.fromEntries(
      [...this.days].map(([dayKey, day]) => [dayKey, Object.fromEntries(day)]),
    );
  }

  /** Entries for the metric emitter. */
  entries(): IterableIterator<[string, T]> {
    return this.models.entries();
  }

  private addToDay(dayKey: string, model: string, delta: T): void {
    let day = this.days.get(dayKey);
    if (day === undefined) {
      day = new Map();
      this.days.set(dayKey, day);
    }
    addCallUsage(day, model, delta);
  }
}

/** `a` minus `b` per model, dropping models with no calls left. */
export function subtractCallUsage<T extends CallUsage>(
  a: Readonly<Record<string, T>> | undefined,
  b: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [model, usage] of Object.entries(a ?? {})) {
    const rest = b?.[model] === undefined ? usage : takeCallUsage(usage, b[model]);
    if (rest !== null) out[model] = rest;
  }
  return out;
}

/** `a` plus `b` per model. */
export function addCallUsageRecords<T extends CallUsage>(
  a: Readonly<Record<string, T>> | undefined,
  b: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const out: Record<string, T> = { ...a };
  sumCallUsageInto(out, b);
  return out;
}

/** Applies a per-model combiner to each day present in either side; days that end empty are dropped. */
export function combineCallUsageByDay<T extends CallUsage>(
  a: Readonly<CallUsageByDay<T>> | undefined,
  b: Readonly<CallUsageByDay<T>> | undefined,
  combine: (
    a: Readonly<Record<string, T>> | undefined,
    b: Readonly<Record<string, T>> | undefined,
  ) => Record<string, T> | undefined,
): CallUsageByDay<T> {
  const out: CallUsageByDay<T> = {};
  for (const dayKey of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const perModel = combine(a?.[dayKey], b?.[dayKey]);
    if (perModel !== undefined && Object.keys(perModel).length > 0) out[dayKey] = perModel;
  }
  return out;
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
  const out = Object.create(null) as Record<string, T>;
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

/**
 * Parses an untrusted persisted per-day record; days that parse to nothing are
 * dropped. An object that keeps no day is `{}`, not undefined: undefined means
 * a summary written before day buckets existed.
 */
export function parseCallUsageByDay<T extends CallUsage>(
  value: unknown,
  parseExtra: (entry: Record<string, unknown>) => Omit<T, keyof CallUsage> | null,
): CallUsageByDay<T> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out = Object.create(null) as CallUsageByDay<T>;
  for (const [dayKey, perModel] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseCallUsageRecord<T>(perModel, parseExtra);
    if (parsed !== undefined) out[dayKey] = parsed;
  }
  return out;
}
