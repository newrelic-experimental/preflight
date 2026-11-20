import { describe, expect, it, jest } from '@jest/globals';

const spawn = jest.fn((..._args: unknown[]) => ({ on: jest.fn(), unref: jest.fn() }));
jest.mock('node:child_process', () => ({ spawn }));

import { openUrl } from './open-url.js';

describe('openUrl', () => {
  it.each([
    ['darwin', 'open', ['http://127.0.0.1:7777']],
    ['linux', 'xdg-open', ['http://127.0.0.1:7777']],
    ['win32', 'cmd', ['/c', 'start', '""', 'http://127.0.0.1:7777']],
  ] as const)('uses the %s opener with the URL as an argument', (platform, cmd, args) => {
    expect(openUrl('http://127.0.0.1:7777', platform)).toBe(true);
    expect(spawn).toHaveBeenLastCalledWith(cmd, args, expect.objectContaining({ detached: true }));
  });

  it('returns false when the opener cannot start', () => {
    spawn.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(openUrl('http://127.0.0.1:7777', 'linux')).toBe(false);
  });
});
