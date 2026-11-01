import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

export const DRAIN_SEAL = '\0preflight-drain-seal\n';
const TORN_SEAL_RE = /\0[a-z-]*/g;

const MAX_REDOS = 5;
const MAX_OPENS = 100;
const READ_ONLY_CODES: ReadonlySet<string | undefined> = new Set(['EACCES', 'EPERM', 'EROFS']);

type Landing = 'kept' | 'moved' | 'redo';

export function textBeforeSeal(raw: string): string {
  const seal = raw.indexOf(DRAIN_SEAL);
  return (seal === -1 ? raw : raw.slice(0, seal)).replace(TORN_SEAL_RE, '');
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
    if (!isAt(path, opened)) return 'moved';
    const sealFloor = opened.size;
    const written = writeSync(fd, data);
    if (written < data.length) {
      writeSync(fd, '\n');
      return 'redo';
    }
    if (isAt(path, opened)) return 'kept';
    const start = offsetAfterWrite(fd) - data.length;
    return readRange(fd, sealFloor, start).includes(DRAIN_SEAL) ? 'redo' : 'kept';
  } finally {
    closeSync(fd);
  }
}

export function appendToHookBuffer(path: string, text: string): void {
  if (text.includes('\0')) {
    throw new Error(`Hook buffer text contains NUL, which marks a drain seal: ${path}`);
  }
  const data = Buffer.from(text);
  let redos = 0;
  for (let opens = 0; opens < MAX_OPENS; opens++) {
    const landing = appendOnce(path, data);
    if (landing === 'kept') return;
    if (landing === 'redo' && ++redos === MAX_REDOS) break;
  }
  throw new Error(`Hook buffer write raced a drain on all attempts and was not kept: ${path}`);
}

function writeSeal(fd: number, path: string): void {
  if (writeSync(fd, DRAIN_SEAL) < Buffer.byteLength(DRAIN_SEAL)) {
    throw new Error(`Short write while sealing ${path}`);
  }
}

export function sealHookBuffer(path: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    writeSeal(fd, path);
  } finally {
    closeSync(fd);
  }
}

export function readSealed(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND);
  } catch (err) {
    if (!READ_ONLY_CODES.has((err as NodeJS.ErrnoException).code)) throw err;
    // No writer can open this file to append either, so no seal is needed.
    return textBeforeSeal(readFileSync(path, 'utf-8'));
  }
  try {
    const head = readRange(fd, 0, fstatSync(fd).size);
    if (head.includes(DRAIN_SEAL)) return textBeforeSeal(head.toString('utf-8'));
    writeSeal(fd, path);
    const tail = readRange(fd, head.length, fstatSync(fd).size);
    return textBeforeSeal(Buffer.concat([head, tail]).toString('utf-8'));
  } finally {
    closeSync(fd);
  }
}

export function takeClaimText(path: string): string {
  const text = readSealed(path);
  unlinkSync(path);
  return text;
}
