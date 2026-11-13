import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A pre without a toolUseId mints one, and its post takes it back, so the call
 * pairs by id even when different processes drain the two. The queue is a
 * directory next to the buffer with one empty file per minted id, named
 * `<pre ms>.<tool key>.<id>`, so names sort oldest first. A post
 * takes the oldest entry of its tool that it can claim.
 */
export const MINTED_IDS_DIR_PREFIX = 'minted-ids-';

// Outlasts every window in which HookEventProcessor would still pair the post
// with its pre: a permission prompt, a subagent's TTL and the late-post window.
const MINTED_ID_TTL_MS = 40 * 60_000;
const MAX_LISTINGS = 5;

function mintedIdsDir(bufferPath: string): string {
  return join(dirname(bufferPath), MINTED_IDS_DIR_PREFIX + basename(bufferPath, '.jsonl'));
}

function toolKey(tool: string): string {
  return createHash('sha256').update(tool.toLowerCase()).digest('hex').slice(0, 16);
}

export function mintToolUseId(bufferPath: string, tool: string, at: number): string | undefined {
  const id = randomUUID();
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
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return undefined;
    }
    let contended = false;
    for (const name of names) {
      const [mintedAt, entryKey, id, claimed] = name.split('.');
      if (entryKey !== key || id === undefined || claimed !== undefined) continue;
      if (!claim(join(dir, name))) {
        contended = true;
        continue;
      }
      if (at - Number(mintedAt) <= MINTED_ID_TTL_MS) return id;
    }
    if (!contended) return undefined;
  }
  return undefined;
}

// Two hooks can both see an unlink of one name succeed on APFS, so the
// exclusive create of a claim file decides the take, and the entry is gone
// before the claim is.
function claim(entry: string): boolean {
  const claimPath = `${entry}.claimed`;
  try {
    closeSync(openSync(claimPath, 'wx', 0o600));
  } catch {
    return false;
  }
  try {
    unlinkSync(entry);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(claimPath, { force: true });
  }
}
