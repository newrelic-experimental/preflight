import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DrainHold,
  formatClaimName,
  parseClaimName,
  STOP_ON_FAILED_CLAIM_POLLS,
} from './drain-claims.js';

const BUFFER = 'buffer-claims.jsonl';
const MAIN_CLAIM_NAME_RE = /^(.+\.jsonl)\.(\d+)\.(\d+)\.[0-9a-f]+$/;

let dir: string;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = fs.mkdtempSync(resolve(tmpdir(), 'nr-drain-claims-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claim names', () => {
  it('orders an old 12-hex nonce by claimedAt and a 24-hex tag by its firstClaimedAt', () => {
    const old = parseClaimName(`${BUFFER}.4242.1700000300000.0123456789ab`);
    const adopted = parseClaimName(`${BUFFER}.4243.1700000600000.018bcfe56800aabbccddeeff`);

    expect(old).toEqual({
      buffer: BUFFER,
      owner: 4242,
      claimedAt: 1700000300000,
      firstClaimedAt: 1700000300000,
    });
    expect(adopted).toEqual({
      buffer: BUFFER,
      owner: 4243,
      claimedAt: 1700000600000,
      firstClaimedAt: 1700000000000,
    });
  });

  it('reads back what formatClaimName wrote, in the grammar the previous release parses', () => {
    const adopted = formatClaimName(BUFFER, 4242, 1700000600000, 1700000000000);
    const fresh = formatClaimName(BUFFER, 4242, 1700000600000);

    expect(adopted).toMatch(MAIN_CLAIM_NAME_RE);
    expect(parseClaimName(adopted)).toEqual({
      buffer: BUFFER,
      owner: 4242,
      claimedAt: 1700000600000,
      firstClaimedAt: 1700000000000,
    });
    expect(parseClaimName(fresh)?.firstClaimedAt).toBe(1700000600000);
  });
});

describe('DrainHold', () => {
  it('returns a claim whose order it gave up once the claim comes free, and ends the hold', () => {
    const path = resolve(dir, formatClaimName(BUFFER, 4242, Date.now()));
    fs.writeFileSync(path, 'A\n');
    fs.chmodSync(dir, 0o500);
    const hold = new DrainHold();

    for (let poll = 1; poll <= STOP_ON_FAILED_CLAIM_POLLS; poll++) {
      expect(hold.take(path, false)).toBe('stop');
      hold.endPoll();
    }
    expect(hold.take(path, false)).toBe('skip');
    hold.endPoll();
    expect(hold.idle).toBe(false);

    fs.chmodSync(dir, 0o700);
    expect(hold.take(path, false)).toEqual({ text: 'A\n' });
    hold.endPoll();

    expect(hold.idle).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
  });
});
