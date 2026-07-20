/**
 * Shared seam for per-file MCP tool registration.
 *
 * Each `src/tools/*.ts` file exports a `registerXTools(deps)` that builds a
 * `ToolSpec[]` — one entry per tool it owns, declaring its `tools/list`
 * availability and its `tools/call` handler in one place — and turns it into
 * a `RegisteredToolSet` via `buildToolSet()`. `session-stats.ts`'s
 * `registerTools()` composes every file's set with `mergeToolSets()` into the
 * server's single `ListToolsRequestSchema`/`CallToolRequestSchema` pair.
 *
 * A spec's `available` flag only gates whether the tool is *listed* —
 * its handler stays dispatchable either way, so a client that calls an
 * unlisted tool still gets the tool's own explanatory error (see
 * `requireTracker`/`requireAvailable`) instead of a generic unknown-tool
 * error.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface ToolCallResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly isError?: boolean;
  // The MCP SDK's result schemas are all `z.core.$loose` (they carry an
  // implicit `[x: string]: unknown` index signature). Fresh object literals
  // get an exemption from needing one to satisfy that; a value passed
  // through this named interface via a variable does not, so it needs one
  // explicitly to remain assignable at the `setRequestHandler` boundary.
  readonly [key: string]: unknown;
}

export type ToolHandlerFn = (
  args: Record<string, unknown> | undefined,
) => ToolCallResult | Promise<ToolCallResult>;

export interface ToolSpec {
  readonly definition: ToolDefinition;
  readonly available: boolean;
  readonly handle: ToolHandlerFn;
}

export interface RegisteredToolSet {
  readonly tools: ToolDefinition[];
  readonly handlers: Record<string, ToolHandlerFn>;
}

export function errorResult(message: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function requireTracker<T>(
  tracker: T | undefined,
  name: string,
): { ok: true; value: T } | { ok: false; result: ToolCallResult } {
  if (tracker === undefined) {
    return { ok: false, result: errorResult(`${name} not available`) };
  }
  return { ok: true, value: tracker };
}

export function requireAvailable(condition: boolean, message: string): ToolCallResult | undefined {
  return condition ? undefined : errorResult(message);
}

export function buildToolSet(specs: ToolSpec[]): RegisteredToolSet {
  const tools: ToolDefinition[] = [];
  const handlers: Record<string, ToolHandlerFn> = {};

  for (const spec of specs) {
    if (spec.available) {
      tools.push(spec.definition);
    }
    handlers[spec.definition.name] = spec.handle;
  }

  return { tools, handlers };
}

export function mergeToolSets(...sets: RegisteredToolSet[]): RegisteredToolSet {
  const tools: ToolDefinition[] = [];
  const handlers: Record<string, ToolHandlerFn> = {};

  for (const set of sets) {
    tools.push(...set.tools);
    Object.assign(handlers, set.handlers);
  }

  return { tools, handlers };
}
