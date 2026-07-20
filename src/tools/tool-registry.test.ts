import { describe, it, expect } from '@jest/globals';
import {
  errorResult,
  requireTracker,
  requireAvailable,
  buildToolSet,
  mergeToolSets,
  type ToolSpec,
} from './tool-registry.js';

describe('errorResult()', () => {
  it('wraps a message in an isError content block', () => {
    const result = errorResult('SomeTracker not available');
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'SomeTracker not available' });
  });
});

describe('requireTracker()', () => {
  it('returns ok:false with an explanatory error when the tracker is undefined', () => {
    const check = requireTracker(undefined, 'BudgetTracker');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.result.isError).toBe(true);
      expect(JSON.parse(check.result.content[0]!.text)).toEqual({
        error: 'BudgetTracker not available',
      });
    }
  });

  it('returns ok:true with the tracker value when it is present', () => {
    const tracker = { getStatus: () => 'ok' };
    const check = requireTracker(tracker, 'BudgetTracker');
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.value).toBe(tracker);
    }
  });
});

describe('requireAvailable()', () => {
  it('returns undefined when the condition is true', () => {
    expect(requireAvailable(true, 'unused')).toBeUndefined();
  });

  it('returns an explanatory error result when the condition is false', () => {
    const result = requireAvailable(false, 'teamId or nrApiKey not configured');
    expect(result?.isError).toBe(true);
    expect(JSON.parse(result!.content[0]!.text)).toEqual({
      error: 'teamId or nrApiKey not configured',
    });
  });
});

describe('buildToolSet()', () => {
  const availableSpec: ToolSpec = {
    definition: { name: 'tool_a', description: 'A', inputSchema: { type: 'object' } },
    available: true,
    handle: () => ({ content: [{ type: 'text', text: 'a' }] }),
  };
  const unavailableSpec: ToolSpec = {
    definition: { name: 'tool_b', description: 'B', inputSchema: { type: 'object' } },
    available: false,
    handle: () => ({ content: [{ type: 'text', text: 'b-unavailable' }], isError: true }),
  };

  it('only lists tool definitions whose spec is available', () => {
    const { tools } = buildToolSet([availableSpec, unavailableSpec]);
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['tool_a']);
  });

  it('keeps every spec dispatchable regardless of availability', async () => {
    const { handlers } = buildToolSet([availableSpec, unavailableSpec]);
    expect(Object.keys(handlers).sort()).toEqual(['tool_a', 'tool_b']);
    const result = await handlers.tool_b!(undefined);
    expect(result.content[0]!.text).toBe('b-unavailable');
  });
});

describe('mergeToolSets()', () => {
  it('concatenates tools and merges handlers across multiple sets', () => {
    const setA = buildToolSet([
      {
        definition: { name: 'tool_a', description: 'A', inputSchema: { type: 'object' } },
        available: true,
        handle: () => ({ content: [{ type: 'text', text: 'a' }] }),
      },
    ]);
    const setB = buildToolSet([
      {
        definition: { name: 'tool_c', description: 'C', inputSchema: { type: 'object' } },
        available: true,
        handle: () => ({ content: [{ type: 'text', text: 'c' }] }),
      },
    ]);

    const merged = mergeToolSets(setA, setB);

    expect(merged.tools.map((t: { name: string }) => t.name)).toEqual(['tool_a', 'tool_c']);
    expect(Object.keys(merged.handlers).sort()).toEqual(['tool_a', 'tool_c']);
  });
});
