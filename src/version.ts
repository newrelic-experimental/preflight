import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function readVersion(): string {
  // Binary path: dist/index.js → ../package.json. Only valid from dist/index.js;
  // dist/hooks/collector-script.js resolves to dist/package.json (nonexistent) and falls through.
  const scriptDir = process.argv[1] ? dirname(process.argv[1]) : null;
  if (scriptDir) {
    const fromScript = resolve(scriptDir, '..', 'package.json');
    if (existsSync(fromScript)) {
      return (JSON.parse(readFileSync(fromScript, 'utf-8')) as { version: string }).version;
    }
  }
  // Fallback: cwd is reliable when running tests or `node dist/index.js` from repo root
  const fromCwd = resolve(process.cwd(), 'package.json');
  if (existsSync(fromCwd)) {
    return (JSON.parse(readFileSync(fromCwd, 'utf-8')) as { version: string }).version;
  }
  return '0.0.0';
}

export const VERSION = readVersion();
