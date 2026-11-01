import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

// A drain unlinks a claim before appending this seal and keeps only what
// precedes it. A writer that still sees a link after its write is therefore
// before the seal; one that lands after the seal writes its line again.
// JSON.stringify escapes NUL, so no event line contains the seal.
const DRAIN_SEAL = '\0preflight-drain-seal\n';

const MAX_APPEND_ATTEMPTS = 5;

function readFromStart(fd: number): string {
  const buf = Buffer.alloc(fstatSync(fd).size);
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, read);
    if (n === 0) break;
    read += n;
  }
  return buf.toString('utf-8', 0, read);
}

export function appendToHookBuffer(path: string, text: string): void {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 0o600);
    try {
      writeFileSync(fd, text);
      if (fstatSync(fd).nlink > 0) return;
      const raw = readFromStart(fd);
      const seal = raw.indexOf(DRAIN_SEAL);
      if (seal === -1 || !raw.includes(text, seal)) return;
    } finally {
      closeSync(fd);
    }
  }
}

/** Takes a claim's lines and deletes it. Throws, leaving the claim in place, when the delete fails. */
export function takeClaimText(path: string): string {
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND);
  try {
    unlinkSync(path);
    writeFileSync(fd, DRAIN_SEAL);
    const raw = readFromStart(fd);
    return raw.slice(0, raw.indexOf(DRAIN_SEAL));
  } finally {
    closeSync(fd);
  }
}
