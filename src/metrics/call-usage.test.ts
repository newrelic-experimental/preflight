import { describe, it, expect } from '@jest/globals';
import { CallUsageBook, parseCallUsageByDay, type CallUsage } from './call-usage.js';

const noExtra = (): Omit<CallUsage, keyof CallUsage> => ({});

describe('parseCallUsageByDay', () => {
  it.each([
    ['a string', 'x'],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ d1: { a: { calls: 1, tokens: 2 } } }]],
  ])('returns undefined for %s', (_label, value) => {
    expect(parseCallUsageByDay(value, noExtra)).toBeUndefined();
  });

  it('keeps an empty object as an empty day map', () => {
    expect(parseCallUsageByDay({}, noExtra)).toEqual({});
  });

  it('drops bad entries and days that parse to nothing', () => {
    expect(
      parseCallUsageByDay(
        {
          d1: { a: { calls: 1, tokens: 2 }, bad: { calls: -1, tokens: 2 } },
          d2: 5,
          d3: { b: { calls: 'x', tokens: 2 } },
        },
        noExtra,
      ),
    ).toEqual({ d1: { a: { calls: 1, tokens: 2 } } });
  });

  it('keeps a __proto__ day key as data without changing the result prototype', () => {
    const parsed = parseCallUsageByDay(
      JSON.parse('{"__proto__":{"a":{"calls":1,"tokens":2}},"d1":{"a":{"calls":3,"tokens":4}}}'),
      noExtra,
    );
    expect(parsed === undefined ? 'missing' : Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.entries(parsed ?? {})).toEqual([
      ['__proto__', { a: { calls: 1, tokens: 2 } }],
      ['d1', { a: { calls: 3, tokens: 4 } }],
    ]);
  });
});

describe('CallUsageBook', () => {
  it('books persisted counts to the fallback day only when the day map is absent', () => {
    const legacy = new CallUsageBook<CallUsage>();
    legacy.addRecords({ a: { calls: 2, tokens: 4 } }, undefined, '2026-11-08');
    expect(legacy.byDay()).toEqual({ '2026-11-08': { a: { calls: 2, tokens: 4 } } });

    const lateOnly = new CallUsageBook<CallUsage>();
    lateOnly.addRecords({ a: { calls: 2, tokens: 4 } }, {}, '2026-11-08');
    expect(lateOnly.byModel()).toEqual({ a: { calls: 2, tokens: 4 } });
    expect(lateOnly.byDay()).toEqual({});
  });
});
