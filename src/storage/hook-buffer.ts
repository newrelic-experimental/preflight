import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

// A drain appends this seal to a claim and keeps only what precedes it, so a
// write after the seal is the writer's to redo. JSON.stringify escapes NUL,
// so no event line contains the seal or a fragment of it.
const DRAIN_SEAL = '\0preflight-drain-seal\n';
const SEAL_FRAGMENT_RE = /\0[a-z-]*/g;

// A write that lands after a seal is redone, up to MAX_REDOS times. Finding
// the path moved before writing costs nothing, so it has its own looser cap.
const MAX_REDOS = 5;
const MAX_OPENS = 100;

type Landing = 'kept' | 'moved' | 'redo';

/** The lines of a buffer or claim file that a drain of it returns. */
export function textBeforeSeal(raw: string): string {
  const seal = raw.indexOf(DRAIN_SEAL);
  return (seal === -1 ? raw : raw.slice(0, seal)).replace(SEAL_FRAGMENT_RE, '');
}

function readRange(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

function readToEnd(fd: number, scratch: Buffer): number {
  let total = 0;
  for (let n; (n = readSync(fd, scratch, 0, scratch.length, null)) > 0;) total += n;
  return total;
}

// After an O_APPEND write the fd's offset is the end of that write. Reading
// on from it counts the bytes appended since, and a size that no further
// read moves past pins the offset.
function offsetAfterWrite(fd: number): number {
  const scratch = Buffer.alloc(64 * 1024);
  let after = readToEnd(fd, scratch);
  for (;;) {
    const size = fstatSync(fd).size;
    const more = readToEnd(fd, scratch);
    if (more === 0) return size - after;
    after += more;
  }
}

function isAt(path: string, file: { readonly ino: number; readonly dev: number }): boolean {
  const now = statSync(path, { throwIfNoEntry: false });
  return now !== undefined && now.ino === file.ino && now.dev === file.dev;
}

function appendOnce(path: string, data: Buffer): Landing {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 0o600);
  try {
    const opened = fstatSync(fd);
    // Still at the path after this fstat means no drain had claimed the file
    // yet, so any seal lands at or after `opened.size`.
    if (!isAt(path, opened)) return 'moved';
    const written = writeSync(fd, data);
    if (written < data.length) {
      writeSync(fd, '\n');
      return 'redo';
    }
    if (isAt(path, opened)) return 'kept';
    const start = offsetAfterWrite(fd) - data.length;
    return readRange(fd, opened.size, start).includes(DRAIN_SEAL) ? 'redo' : 'kept';
  } finally {
    closeSync(fd);
  }
}

/** Appends `text` to a hook buffer in one write. Throws when it cannot land before a drain seal. */
export function appendToHookBuffer(path: string, text: string): void {
  const data = Buffer.from(text);
  let redos = 0;
  for (let opens = 0; opens < MAX_OPENS; opens++) {
    const landing = appendOnce(path, data);
    if (landing === 'kept') return;
    if (landing === 'redo' && ++redos === MAX_REDOS) break;
  }
  throw new Error(`Hook buffer write raced a drain on all attempts and was not kept: ${path}`);
}

/** Seals a claim and returns its lines, leaving the file in place. */
export function readSealed(path: string): string {
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND);
  try {
    const head = readRange(fd, 0, fstatSync(fd).size);
    if (head.includes(DRAIN_SEAL)) return textBeforeSeal(head.toString('utf-8'));
    if (writeSync(fd, DRAIN_SEAL) < Buffer.byteLength(DRAIN_SEAL)) {
      throw new Error(`Short write while sealing ${path}`);
    }
    const tail = readRange(fd, head.length, fstatSync(fd).size);
    return textBeforeSeal(Buffer.concat([head, tail]).toString('utf-8'));
  } finally {
    closeSync(fd);
  }
}

/** Takes a claim's lines and deletes it. Throws, leaving the claim in place, when any step fails. */
export function takeClaimText(path: string): string {
  const text = readSealed(path);
  unlinkSync(path);
  return text;
}
