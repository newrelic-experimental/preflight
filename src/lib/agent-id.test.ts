import { AGENT_ID_PATTERN, AGENT_ID_RE } from './agent-id.js';

describe('AGENT_ID_RE', () => {
  it('matches the plain anonymous-spawn shape', () => {
    expect(AGENT_ID_RE.test('a1234567890abcde0')).toBe(true);
  });

  it('matches a named-subagent shape with hyphens in the name', () => {
    expect(AGENT_ID_RE.test('aconfluence-istio-investigator-ca0143b626a86424')).toBe(true);
    expect(AGENT_ID_RE.test('agithub-istio-investigator-2d4a726239ab8e6c')).toBe(true);
  });

  it('rejects an id that does not start with "a"', () => {
    expect(AGENT_ID_RE.test('not-a-valid-id')).toBe(false);
  });

  it('rejects a hex suffix shorter or longer than 16 characters', () => {
    expect(AGENT_ID_RE.test('a1234567890abcd')).toBe(false); // 15 hex chars
    expect(AGENT_ID_RE.test('a1234567890abcde01')).toBe(false); // 17 hex chars
  });

  it('rejects a name segment containing non-hex-suffix-terminated garbage', () => {
    expect(AGENT_ID_RE.test('asome-name-not-ending-in-hex')).toBe(false);
  });
});

describe('AGENT_ID_PATTERN', () => {
  it('can be embedded, unanchored, inside a larger regex', () => {
    const re = new RegExp(`^prefix-(${AGENT_ID_PATTERN})-suffix$`);
    const match = re.exec('prefix-aconfluence-istio-investigator-ca0143b626a86424-suffix');
    expect(match?.[1]).toBe('aconfluence-istio-investigator-ca0143b626a86424');
  });
});
