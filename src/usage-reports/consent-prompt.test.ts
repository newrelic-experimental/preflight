import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@jest/globals';
import { isCancel } from '@clack/prompts';

import { consentSelect, NOTHING_CHOSEN_HINT } from './consent-prompt.js';

const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  space: ' ',
  enter: '\r',
  ctrlC: '\x03',
  y: 'y',
  N: 'N',
} as const;

function makePrompt() {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk: Buffer) => (screen += chunk.toString()));
  const result = consentSelect({
    message: 'Share?',
    options: [
      { value: 'yes', label: 'Yes', key: 'y' },
      { value: 'no', label: 'No', key: 'n' },
      { value: 'later', label: 'Not now' },
    ],
    input,
    output,
  });
  const press = async (...keys: (keyof typeof KEYS)[]) => {
    for (const k of keys) {
      input.write(KEYS[k]);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { result, press, screen: () => screen };
}

describe('consentSelect', () => {
  it('starts with nothing chosen, so Enter alone shows a hint instead of answering', async () => {
    const p = makePrompt();
    await p.press('enter');
    expect(p.screen()).toContain(NOTHING_CHOSEN_HINT);
    await p.press('space', 'enter');
    expect(await p.result).toBe('yes');
  });

  it('chooses the focused option with Space, wrapping around the list', async () => {
    const p = makePrompt();
    await p.press('up', 'space', 'enter');
    expect(await p.result).toBe('later');
  });

  it('keeps the last choice when focus moves on without Space', async () => {
    const p = makePrompt();
    await p.press('down', 'space', 'down', 'enter');
    expect(await p.result).toBe('no');
  });

  it('chooses an option with its letter, in either case, and shows the letter', async () => {
    const p = makePrompt();
    expect(p.screen()).toContain('Yes (y)');
    await p.press('N', 'enter');
    expect(await p.result).toBe('no');
    const q = makePrompt();
    await q.press('N', 'y', 'enter');
    expect(await q.result).toBe('yes');
  });

  it('moves focus with Tab without choosing', async () => {
    const p = makePrompt();
    await p.press('tab', 'tab', 'enter');
    expect(p.screen()).toContain(NOTHING_CHOSEN_HINT);
    await p.press('space', 'enter');
    expect(await p.result).toBe('later');
  });

  it('returns the cancel symbol on Ctrl-C', async () => {
    const p = makePrompt();
    await p.press('ctrlC');
    expect(isCancel(await p.result)).toBe(true);
  });
});
