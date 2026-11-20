/** Opens a URL in the default browser. Best effort: returns false when it can't. */

import { spawn } from 'node:child_process';

export function openUrl(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
