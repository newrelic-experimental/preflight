import { closeSync, constants, openSync, writeFileSync } from 'node:fs';

/** Appends `text` to a hook buffer. Every writer of `buffer-*.jsonl` goes through here. */
export function appendToHookBuffer(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
