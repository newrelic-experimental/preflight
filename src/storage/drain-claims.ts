import { readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { createLogger } from '../shared/index.js';
import { takeClaimText } from './hook-buffer.js';

const logger = createLogger('drain-claims');

export const DRAINS_DIR = 'drains';
const LEGACY_DRAIN_SUFFIX = '.drain';
const CLAIM_NAME_RE = /^(.+\.jsonl)\.(\d+)\.(\d+)\.([0-9a-f]+)$/;
const ORDER_HEX_DIGITS = 12;

/**
 * An older version's drainer recovers a legacy `<buffer>.drain` on its next
 * 100 ms poll, and returns those events even when its unlink then fails, so
 * taking the file while it is mid-recovery counts it twice. A `.drain` this
 * process has watched unchanged for 60 s (600 of those polls) has no older
 * drainer that was running throughout. One that starts at about the 60 s mark
 * can still read it first, which is the residual double read in the PR's known
 * limits. File times alone are not trusted: a rename does not update ctime on
 * every filesystem, so the watch stamps inode, size and mtime together.
 */
export const LEGACY_DRAIN_ADOPT_AGE_MS = 60_000;

export const STALE_CLAIM_AGE_MS = 10 * 60_000;

/** Polls in a row, about 5 s at the 100 ms poll, that a drain holds the claims after one it cannot take. */
export const STOP_ON_FAILED_CLAIM_POLLS = 50;

export interface DrainClaim {
  readonly path: string;
  readonly buffer: string;
  readonly owner: number | 'legacy';
  /** When its owner took the claim, which staleness reads. */
  readonly claimedAt: number;
  /** When its lines were first claimed from the buffer, which orders claims; 0 for a legacy `.drain`. */
  readonly firstClaimedAt: number;
}

interface LegacySighting {
  readonly stamp: string;
  readonly since: number;
  readonly first: number;
}

const legacySightings = new Map<string, LegacySighting>();
const failureCounts = new Map<string, number>();
const failedListings = new Set<string>();

export function isBufferName(name: string): boolean {
  return name.endsWith('.jsonl') && (name === 'buffer.jsonl' || name.startsWith('buffer-'));
}

/**
 * `<buffer>.<pid>.<claimedAt>.<tag>`, where the tag is `firstClaimedAt` in 12 hex digits and then
 * 12 random ones. An adopted claim gets a new `claimedAt` and keeps its `firstClaimedAt`, so it is
 * not stale to other drainers and still comes back in order. A version that predates the tag
 * reads it as a nonce, and a 12-digit nonce from such a version orders by `claimedAt`.
 */
export function formatClaimName(
  buffer: string,
  pid: number,
  claimedAt: number,
  firstClaimedAt = claimedAt,
): string {
  const order = firstClaimedAt.toString(16).padStart(ORDER_HEX_DIGITS, '0');
  return `${buffer}.${pid}.${claimedAt}.${order}${randomBytes(6).toString('hex')}`;
}

export function parseClaimName(name: string): Omit<DrainClaim, 'path'> | null {
  const match = CLAIM_NAME_RE.exec(name);
  if (!match) return null;
  const claimedAt = Number(match[3]);
  const tag = match[4]!;
  const firstClaimedAt =
    tag.length > ORDER_HEX_DIGITS ? parseInt(tag.slice(0, ORDER_HEX_DIGITS), 16) : claimedAt;
  return { buffer: match[1]!, owner: Number(match[2]), claimedAt, firstClaimedAt };
}

export function legacyDrainBuffer(name: string): string | null {
  if (!name.endsWith(LEGACY_DRAIN_SUFFIX)) return null;
  const buffer = name.slice(0, -LEGACY_DRAIN_SUFFIX.length);
  return isBufferName(buffer) ? buffer : null;
}

export function sightLegacy(path: string, buffer: string): DrainClaim | null {
  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (!stats) {
    legacySightings.delete(path);
    return null;
  }
  const stamp = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  const seen = legacySightings.get(path);
  if (seen?.stamp !== stamp) {
    const now = Date.now();
    legacySightings.set(path, { stamp, since: now, first: seen?.first ?? now });
  }
  return { path, buffer, owner: 'legacy', claimedAt: 0, firstClaimedAt: 0 };
}

export function forgetLegacySightingsExcept(dir: string, seen: ReadonlySet<string>): void {
  for (const path of legacySightings.keys()) {
    if (dirname(path) === dir && !seen.has(path)) legacySightings.delete(path);
  }
}

/**
 * Whether a drainer may take the claim over. A dead owner's claim is taken at
 * once and a live owner's after `STALE_CLAIM_AGE_MS`. Owner liveness is a
 * scheduling hint, not a safety check: taking a live drainer's claim is safe
 * because its unlink then fails and it returns nothing.
 */
export function isAdoptable(claim: DrainClaim, ownerAlive: (pid: number) => boolean): boolean {
  if (claim.owner === 'legacy') {
    const since = legacySightings.get(claim.path)?.since ?? Number.POSITIVE_INFINITY;
    return Date.now() - since >= LEGACY_DRAIN_ADOPT_AGE_MS;
  }
  return !ownerAlive(claim.owner) || Date.now() - claim.claimedAt >= STALE_CLAIM_AGE_MS;
}

/**
 * True while a legacy `.drain` is still inside its first minute of being
 * watched. Its events predate the buffer's, so the buffer waits for it, but
 * only for that first minute: a `.drain` whose stamp keeps changing because an
 * older drainer is cycling it must not hold the buffer for good.
 */
export function holdsBuffer(claim: DrainClaim, ownerAlive: (pid: number) => boolean): boolean {
  if (claim.owner !== 'legacy' || isAdoptable(claim, ownerAlive)) return false;
  const first = legacySightings.get(claim.path)?.first ?? Number.POSITIVE_INFINITY;
  return Date.now() - first < LEGACY_DRAIN_ADOPT_AGE_MS;
}

/** Counts a repeated failure and warns on the 1st, 2nd, 4th, 8th and later power-of-two failure. */
export function noteFailure(key: string, message: string, err: unknown): void {
  const failures = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, failures);
  if ((failures & (failures - 1)) === 0) {
    logger.warn(message, { error: String(err), failures });
  }
}

export function clearFailure(key: string): void {
  failureCounts.delete(key);
}

/**
 * Seals a claim, reads up to the seal and unlinks it, returning the text only
 * once the unlink has succeeded. A claim whose unlink failed stays on disk for a later poll
 * rather than being counted now and again after a restart.
 */
function takeClaim(path: string): { readonly text: string } | 'gone' | 'stuck' {
  let text: string;
  try {
    text = takeClaimText(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      clearFailure(path);
      logger.debug('Drain claim was adopted by another drainer', { error: String(err) });
      return 'gone';
    }
    noteFailure(path, 'Failed to drain a claimed buffer — retrying each poll', err);
    return 'stuck';
  }
  clearFailure(path);
  return { text };
}

/**
 * Takes one drained buffer's claims in order across polls. A claim that cannot be taken stops
 * the drain, so the claims after it keep their order, for at most `STOP_ON_FAILED_CLAIM_POLLS`
 * polls in a row however many claims are stuck. The next poll, and any final drain, gives up
 * the order of each claim it cannot take: it warns once naming the claim and skips it while it
 * stays stuck, so a claim that never comes free cannot hold the buffer's events for good.
 */
export class DrainHold {
  private stoppedPolls = 0;
  private gaveUp: ReadonlySet<string> = new Set();
  private skipped = new Set<string>();

  get idle(): boolean {
    return this.stoppedPolls === 0 && this.gaveUp.size === 0;
  }

  take(path: string, final: boolean): { readonly text: string } | 'skip' | 'stop' {
    const taken = takeClaim(path);
    if (taken === 'gone') return 'skip';
    if (taken !== 'stuck') return taken;
    if (!this.gaveUp.has(path)) {
      if (!final && this.stoppedPolls < STOP_ON_FAILED_CLAIM_POLLS) return 'stop';
      logger.warn(
        'Gave up holding hook events in order behind a drain claim that cannot be taken',
        {
          claim: path,
          heldPolls: this.stoppedPolls,
          finalDrain: final,
        },
      );
    }
    this.skipped.add(path);
    return 'skip';
  }

  /** A finished poll ends the hold and keeps only the claims still stuck. A stopped one extends it. */
  endPoll(finished: boolean): void {
    if (finished) {
      this.stoppedPolls = 0;
      this.gaveUp = this.skipped;
    } else {
      this.stoppedPolls += 1;
    }
    this.skipped = new Set();
  }
}

/**
 * Claims in `<dir>/drains` plus, for a scoped drain, the legacy `.drain` of its
 * own buffer. A scoped drain takes the claims of its own buffer and this
 * process's own leftover claims of any buffer; an unscoped drain takes all.
 */
export function listClaims(dir: string, scopedTo?: string): DrainClaim[] {
  const claims: DrainClaim[] = [];
  const legacy = scopedTo && sightLegacy(resolve(dir, scopedTo + LEGACY_DRAIN_SUFFIX), scopedTo);
  if (legacy) claims.push(legacy);
  const drainsDir = resolve(dir, DRAINS_DIR);
  let names: string[];
  try {
    names = readdirSync(drainsDir);
    failedListings.delete(drainsDir);
  } catch (err) {
    const failed = (err as NodeJS.ErrnoException).code !== 'ENOENT';
    if (failed && !failedListings.has(drainsDir)) {
      logger.warn('Failed to list drain claims — leftover claims wait until it succeeds', {
        error: String(err),
      });
    }
    if (failed) failedListings.add(drainsDir);
    else failedListings.delete(drainsDir);
    return claims;
  }
  const listed = new Set<string>();
  for (const name of names) {
    const path = resolve(drainsDir, name);
    listed.add(path);
    const parsed = parseClaimName(name);
    if (!parsed) continue;
    if (scopedTo && parsed.buffer !== scopedTo && parsed.owner !== process.pid) continue;
    claims.push({ path, ...parsed });
  }
  for (const key of failureCounts.keys()) {
    if (dirname(key) === drainsDir && !listed.has(key)) failureCounts.delete(key);
  }
  return claims;
}
