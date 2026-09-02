import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { copilotSdkExtensionInstallPath } from '../hooks/copilot-sdk-extension-health.js';

// Isolated in its own file (mirroring copilot-sdk-extension-health.test.ts)
// because copilotSdkExtensionInstallPath() is a hardcoded ~/.copilot/... path
// (not injectable) — mocking node:fs at file scope here would otherwise risk
// leaking into copilot-install-helper.test.ts's real-temp-directory tests.
jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...real, existsSync: jest.fn(), copyFileSync: jest.fn(), mkdirSync: jest.fn() };
});

const REAL_EXISTS_SYNC = jest.requireActual<typeof import('node:fs')>('node:fs').existsSync;
const mockExistsSync = existsSync as jest.Mock;
const mockCopyFileSync = copyFileSync as jest.Mock;
const mockMkdirSync = mkdirSync as jest.Mock;

afterEach(() => {
  mockExistsSync.mockReset();
  mockCopyFileSync.mockReset();
  mockMkdirSync.mockReset();
});

describe('installCopilotSdkExtension()', () => {
  it('does not copy when the extension is already installed', async () => {
    const { installCopilotSdkExtension } = await import('./copilot-install-helper.js');
    mockExistsSync.mockReturnValue(true);

    const result = installCopilotSdkExtension();

    expect(result).toEqual({ copied: false, reason: 'exists' });
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it('copies the bundled extension to the documented install path when absent', async () => {
    const { installCopilotSdkExtension } = await import('./copilot-install-helper.js');
    const destPath = copilotSdkExtensionInstallPath();
    // Only fake the "not installed yet" check at destPath — every other
    // existsSync call (resolveDataDir's own internal directory probing) must
    // hit the real filesystem so it actually finds the real, bundled
    // copilot-sdk-extension/ directory in this checkout.
    mockExistsSync.mockImplementation((p: unknown) =>
      p === destPath ? false : REAL_EXISTS_SYNC(p as string),
    );

    const result = installCopilotSdkExtension();

    expect(result.copied).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('extension.mjs'),
      destPath,
    );
  });

  it('reports a reason string when copyFileSync throws', async () => {
    const { installCopilotSdkExtension } = await import('./copilot-install-helper.js');
    const destPath = copilotSdkExtensionInstallPath();
    mockExistsSync.mockImplementation((p: unknown) =>
      p === destPath ? false : REAL_EXISTS_SYNC(p as string),
    );
    mockCopyFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = installCopilotSdkExtension();

    expect(result).toEqual({ copied: false, reason: 'disk full' });
  });
});
