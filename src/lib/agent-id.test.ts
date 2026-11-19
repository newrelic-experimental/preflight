import {
  AGENT_ID_PATTERN,
  AGENT_ID_RE,
  MAX_AGENT_ID_LENGTH,
  MAX_AGENT_TYPE_LENGTH,
  normalizeAgentId,
  normalizeAgentType,
} from './agent-id.js';

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

describe('normalizeAgentType', () => {
  it('accepts ordinary subagent types', () => {
    expect(normalizeAgentType('Explore')).toBe('Explore');
    expect(normalizeAgentType('general-purpose')).toBe('general-purpose');
    expect(normalizeAgentType('nr-ui:ds-reviewer')).toBe('nr-ui:ds-reviewer');
  });

  it('rejects non-strings, empty, oversized, and control-character values', () => {
    expect(normalizeAgentType(undefined)).toBeUndefined();
    expect(normalizeAgentType(7)).toBeUndefined();
    expect(normalizeAgentType('')).toBeUndefined();
    expect(normalizeAgentType('x'.repeat(MAX_AGENT_TYPE_LENGTH + 1))).toBeUndefined();
    expect(normalizeAgentType('x'.repeat(MAX_AGENT_TYPE_LENGTH))).toHaveLength(
      MAX_AGENT_TYPE_LENGTH,
    );
    expect(normalizeAgentType('Explore\nInjected')).toBeUndefined();
    expect(normalizeAgentType('Explore\u007f')).toBeUndefined();
  });
});

describe('normalizeAgentId', () => {
  it('accepts Claude Code ids and the looser ids other platforms send', () => {
    expect(normalizeAgentId('a1234567890abcde0')).toBe('a1234567890abcde0');
    expect(normalizeAgentId('aconfluence-investigator-ca0143b626a86424')).toBe(
      'aconfluence-investigator-ca0143b626a86424',
    );
    expect(normalizeAgentId('agent-abc123')).toBe('agent-abc123');
    expect(normalizeAgentId('3f2b9c1e-7d4a-4e8b-9a61-0c5d2e8f7b13')).toBe(
      '3f2b9c1e-7d4a-4e8b-9a61-0c5d2e8f7b13',
    );
  });

  it('rejects non-strings, empty, oversized, and control-character values', () => {
    expect(normalizeAgentId(undefined)).toBeUndefined();
    expect(normalizeAgentId(7)).toBeUndefined();
    expect(normalizeAgentId('')).toBeUndefined();
    expect(normalizeAgentId('x'.repeat(MAX_AGENT_ID_LENGTH + 1))).toBeUndefined();
    expect(normalizeAgentId('x'.repeat(MAX_AGENT_ID_LENGTH))).toHaveLength(MAX_AGENT_ID_LENGTH);
    expect(normalizeAgentId('a1234567890abcde0\nInjected')).toBeUndefined();
    expect(normalizeAgentId('a1234567890abcde0\u007f')).toBeUndefined();
  });
});
