import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  copilotSdkExtensionInstallPath,
  isCopilotSdkExtensionMissing,
} from './copilot-sdk-extension-health.js';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...real, existsSync: jest.fn() };
});

const mockExistsSync = existsSync as jest.Mock;

afterEach(() => mockExistsSync.mockReset());

describe('isCopilotSdkExtensionMissing()', () => {
  it('is false for a non-copilot-sdk platform regardless of file presence', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isCopilotSdkExtensionMissing('claude-code')).toBe(false);
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('is true for copilot-sdk when the extension file is absent', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isCopilotSdkExtensionMissing('copilot-sdk')).toBe(true);
  });

  it('is false for copilot-sdk when the extension file is present', () => {
    mockExistsSync.mockReturnValue(true);
    expect(isCopilotSdkExtensionMissing('copilot-sdk')).toBe(false);
  });

  it('checks the documented install path', () => {
    mockExistsSync.mockReturnValue(true);
    isCopilotSdkExtensionMissing('copilot-sdk');
    expect(mockExistsSync).toHaveBeenCalledWith(copilotSdkExtensionInstallPath());
  });
});

describe('copilotSdkExtensionInstallPath()', () => {
  it('resolves to the documented .copilot/extensions/preflight/extension.mjs path', () => {
    const path = copilotSdkExtensionInstallPath();
    expect(path.endsWith(join('.copilot', 'extensions', 'preflight', 'extension.mjs'))).toBe(true);
  });
});
