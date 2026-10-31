import { createHash } from 'node:crypto';

export function hashInput(input: unknown): string {
  const str = JSON.stringify(input) ?? '';
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])]),
  );
}

/**
 * Hash of an MCP call's arguments that the engine can recompute from the
 * `tools/call` it receives. Cursor sends them as a JSON string and Windsurf
 * as an object, so a string is parsed first and keys are sorted.
 */
export function mcpArgumentsHash(input: unknown): string {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      value = input;
    }
  }
  return hashInput(canonicalJson(value));
}
