import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A pre without a toolUseId mints one, and its post takes it back, so the call
 * pairs by id even when different processes drain the two. The queue is a
 * directory next to the buffer with one empty file per minted id, so names
 * sort oldest first:
 *
 * - `<pre ms>.<tool key>.<id>` is open: its pre may still be pending.
 * - `<pre ms>.<tool key>.<id>.<late until ms>` is counted: a processor gave
 *   up waiting and recorded the pre as unpaired, and a late post can still
 *   amend that record until the time in the name.
 *
 * A post takes the oldest open entry of its tool, else the oldest counted one,
 * the same order in which HookEventProcessor pairs a post without an id.
 */
export const MINTED_IDS_DIR_PREFIX = 'minted-ids-';
const MINTED_ID_PREFIX = 'minted-';
const CLAIM_SUFFIX = '.claimed';

// An open entry this old has no processor that would still pair its post:
// every processor counts a pending pre within 30 minutes.
const OPEN_ENTRY_TTL_MS = 40 * 60_000;
const MAX_LISTINGS = 5;

interface Entry {
  readonly name: string;
  readonly mintedAt: number;
  readonly key: string;
  readonly id: string;
  readonly lateUntil: number | undefined;
}

export function isMintedToolUseId(id: string): boolean {
  return id.startsWith(MINTED_ID_PREFIX);
}

function mintedIdsDir(bufferPath: string): string {
  return join(dirname(bufferPath), MINTED_IDS_DIR_PREFIX + basename(bufferPath, '.jsonl'));
}

// Two 32-bit FNV-1a hashes with different offsets. A post would otherwise be
// the collector's first use of sha256, whose setup costs about 0.25 ms.
function toolKey(tool: string): string {
  const name = tool.toLowerCase();
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < name.length; i++) {
    a = Math.imul(a ^ name.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ name.charCodeAt(i), 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function parseEntry(name: string): Entry | undefined {
  if (name.endsWith(CLAIM_SUFFIX)) return undefined;
  const [mintedAt, key, id, lateUntil, extra] = name.split('.');
  if (key === undefined || id === undefined || extra !== undefined) return undefined;
  return {
    name,
    mintedAt: Number(mintedAt),
    key,
    id,
    lateUntil: lateUntil === undefined ? undefined : Number(lateUntil),
  };
}

function listEntries(dir: string): Entry[] | undefined {
  try {
    return readdirSync(dir)
      .sort()
      .flatMap((name) => parseEntry(name) ?? []);
  } catch {
    return undefined;
  }
}

export function mintToolUseId(bufferPath: string, tool: string, at: number): string | undefined {
  const id = MINTED_ID_PREFIX + randomUUID();
  try {
    const dir = mintedIdsDir(bufferPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${at}.${toolKey(tool)}.${id}`), '', {
      flag: 'wx',
      mode: 0o600,
    });
    return id;
  } catch {
    return undefined;
  }
}

export function takeMintedToolUseId(
  bufferPath: string,
  tool: string,
  at: number,
): string | undefined {
  const dir = mintedIdsDir(bufferPath);
  const key = toolKey(tool);
  for (let listing = 0; listing < MAX_LISTINGS; listing++) {
    const entries = listEntries(dir)?.filter((entry) => entry.key === key);
    if (entries === undefined) return undefined;
    const open = entries.filter((entry) => entry.lateUntil === undefined);
    const counted = entries.filter((entry) => entry.lateUntil !== undefined);
    let contended = false;
    for (const entry of [...open, ...counted]) {
      if (!claim(join(dir, entry.name), unlinkSync)) {
        contended = true;
        continue;
      }
      const expired =
        entry.lateUntil === undefined
          ? at - entry.mintedAt > OPEN_ENTRY_TTL_MS
          : at > entry.lateUntil;
      if (!expired) return entry.id;
    }
    if (!contended) return undefined;
  }
  return undefined;
}

/**
 * Marks an open entry counted once a processor records its pre as unpaired, so
 * a later post takes it only when no open entry of its tool is left. An entry a
 * post already took is left alone: that post amends the record.
 */
export function countMintedToolUseId(bufferPath: string, id: string, lateUntil: number): void {
  const dir = mintedIdsDir(bufferPath);
  const entry = listEntries(dir)?.find((e) => e.id === id && e.lateUntil === undefined);
  if (entry === undefined) return;
  const path = join(dir, entry.name);
  claim(path, () => renameSync(path, `${path}.${lateUntil}`));
}

// Two hooks can both see an unlink of one name succeed on APFS, so the
// exclusive create of a claim file decides who acts on an entry, and the
// entry is gone before the claim is.
function claim(entry: string, act: (entry: string) => void): boolean {
  const claimPath = entry + CLAIM_SUFFIX;
  try {
    closeSync(openSync(claimPath, 'wx', 0o600));
  } catch {
    return false;
  }
  try {
    act(entry);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(claimPath);
    } catch {
      // A claim file left behind only makes later takes skip its entry.
    }
  }
}
