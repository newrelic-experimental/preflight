import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installCopilotSdkExtension } from './copilot-install-helper.js';
import { copilotSdkExtensionInstallPath } from '../hooks/copilot-sdk-extension-health.js';

const OLD_EXTENSION = `// Preflight — GitHub Copilot SDK usage-capture extension
import { appendFileSync } from 'node:fs';
process.stderr.write(\`preflight extension: failed to write token line\\n\`);
`;

const FOREIGN_EXTENSION = `// my own copilot extension\nexport default {};\n`;

describe('installCopilotSdkExtension() upgrades an existing install', () => {
  let home: string;
  let prevHome: string | undefined;
  let dest: string;
  const bundled = readFileSync(
    resolve(__dirname, '../../copilot-sdk-extension/extension.mjs'),
    'utf8',
  );

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'pf-ext-upgrade-'));
    process.env.HOME = home;
    dest = copilotSdkExtensionInstallPath();
    mkdirSync(dirname(dest), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('replaces an older Preflight extension with the shipped bundle', () => {
    writeFileSync(dest, OLD_EXTENSION);

    const result = installCopilotSdkExtension();

    expect(result).toEqual({ action: 'updated' });
    expect(readFileSync(dest, 'utf8')).toBe(bundled);
  });

  it('leaves an identical install untouched and reports it unchanged', () => {
    writeFileSync(dest, bundled);
    const before = statSync(dest).mtimeMs;

    const result = installCopilotSdkExtension();

    expect(result).toEqual({ action: 'unchanged' });
    expect(statSync(dest).mtimeMs).toBe(before);
  });

  it('does not overwrite a file that is not a Preflight extension', () => {
    writeFileSync(dest, FOREIGN_EXTENSION);

    const result = installCopilotSdkExtension();

    expect(result).toEqual({ action: 'skipped', reason: 'not-preflight' });
    expect(readFileSync(dest, 'utf8')).toBe(FOREIGN_EXTENSION);
  });

  it('writes a fresh install when no file exists', () => {
    const result = installCopilotSdkExtension();

    expect(result).toEqual({ action: 'copied' });
    expect(readFileSync(dest, 'utf8')).toBe(bundled);
  });

  it('keeps the existing file mode on upgrade and leaves no temp file behind', () => {
    writeFileSync(dest, OLD_EXTENSION);
    chmodSync(dest, 0o640);

    installCopilotSdkExtension();

    expect(statSync(dest).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(dest))).toEqual(['extension.mjs']);
  });
});
