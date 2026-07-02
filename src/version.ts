import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function readVersion(): string {
  const scriptArg = process.argv[1];
  if (scriptArg) {
    let resolved: string;
    try {
      resolved = realpathSync(scriptArg);
    } catch {
      // Broken symlink or permission error — fall back to the unresolved path.
      // The existsSync guard below will prevent reading a nonexistent file.
      resolved = scriptArg;
    }
    const fromScript = resolve(dirname(resolved), '..', 'package.json');
    if (existsSync(fromScript)) {
      return (JSON.parse(readFileSync(fromScript, 'utf-8')) as { version: string }).version;
    }
  }
  // Fallback: cwd is reliable when running tests or `node dist/index.js` from repo root.
  const fromCwd = resolve(process.cwd(), 'package.json');
  if (existsSync(fromCwd)) {
    return (JSON.parse(readFileSync(fromCwd, 'utf-8')) as { version: string }).version;
  }
  return '0.0.0';
}

export const VERSION = readVersion();
