import { describe, it, expect } from '@jest/globals';
import { HOOK_EVENT_TYPES, HOOK_SUBCOMMANDS, hookEventFromArg } from './hook-subcommands.js';

describe('hookEventFromArg', () => {
  it.each(HOOK_EVENT_TYPES)('resolves the event name %s in any case', (event) => {
    expect(hookEventFromArg(event)).toBe(event);
    expect(hookEventFromArg(event.toLowerCase())).toBe(event);
    expect(hookEventFromArg(event.toUpperCase())).toBe(event);
  });

  it.each(HOOK_EVENT_TYPES)('resolves the subcommand marker for %s in any case', (event) => {
    expect(hookEventFromArg(HOOK_SUBCOMMANDS[event])).toBe(event);
    expect(hookEventFromArg(HOOK_SUBCOMMANDS[event].toUpperCase())).toBe(event);
  });

  it('returns undefined for a missing or unrecognized argument', () => {
    expect(hookEventFromArg(undefined)).toBeUndefined();
    expect(hookEventFromArg('')).toBeUndefined();
    expect(hookEventFromArg('pre_tool')).toBeUndefined();
    expect(hookEventFromArg('session-start')).toBeUndefined();
  });
});
