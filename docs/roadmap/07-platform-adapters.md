# Implementation Plan: Additional Platform Adapters

**Roadmap item:** [05 — Additional Platform Adapters](../../ROADMAP.md#5-additional-platform-adapters)
**Effort estimate:** ~1 day (all three adapters)
**Prerequisites:** Read the following files before starting.

---

## Background reading

Read these files end-to-end before starting:

- `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.ts` — the simplest existing adapter; use as the template
- `packages/nr-ai-mcp-server/src/platforms/types.ts` — `PlatformAdapter`, `NormalizedToolCall`, `PlatformConfig`, `PlatformSessionMetadata` interfaces
- `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts` — how adapters are registered in `createDefaultRegistry()`
- `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.test.ts` — test pattern to follow for each new adapter

---

## Goal

Add three new platform adapters:

1. **ZedAdapter** — Zed editor (fast-growing, native MCP support via `zed-mcp-server`)
2. **ContinueAdapter** — Continue.dev (open-source IDE extension for VS Code and JetBrains)
3. **AmazonQAdapter** — Amazon Q Developer (formerly CodeWhisperer)

Each adapter follows the exact same shape as `CursorAdapter`. The main differences are:
- Detection env vars / config file presence
- Tool name mapping (platform tool names → shared vocabulary)
- Hook install instructions

---

## Step 1 — ZedAdapter

### Tool name mapping

Zed's MCP tool calls use these names (from the Zed MCP implementation):

```typescript
const ZED_TOOL_MAP: Record<string, string> = {
  // File operations
  open_file: 'Read',
  read_file: 'Read',
  create_file: 'Write',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  // Search
  search_files: 'Glob',
  find_in_files: 'Grep',
  search_in_file: 'Grep',
  // Terminal
  execute_command: 'Bash',
  run_command: 'Bash',
  // Navigation
  list_files: 'Glob',
  list_directory: 'Glob',
};
```

### Detection heuristics

Zed sets these environment variables when spawning MCP servers:

```typescript
isSupported(): boolean {
  return (
    process.env.ZED_SESSION_ID !== undefined ||
    process.env.ZED_EXTENSION_API_VERSION !== undefined ||
    process.env.MCP_CLIENT === 'zed' ||
    process.env.ZED_ITEM_ID !== undefined
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const ZED_TOOL_MAP: Record<string, string> = {
  open_file: 'Read',
  read_file: 'Read',
  create_file: 'Write',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  search_files: 'Glob',
  find_in_files: 'Grep',
  search_in_file: 'Grep',
  execute_command: 'Bash',
  run_command: 'Bash',
  list_files: 'Glob',
  list_directory: 'Glob',
};

interface ZedToolCallEvent {
  tool?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class ZedAdapter implements PlatformAdapter {
  readonly platformName = 'zed';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Zed spawns MCP servers as child processes. Tool calls arrive via stdio.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ZedToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = ZED_TOOL_MAP[platformToolName] ?? 'Unknown';

    return {
      toolName,
      platformToolName,
      platform: this.platformName,
      timestamp: event.timestamp ?? Date.now(),
      durationMs: event.durationMs ?? null,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(event.filePath !== undefined && { filePath: event.filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.ZED_EXTENSION_API_VERSION && {
        ideVersion: process.env.ZED_EXTENSION_API_VERSION,
      }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Zed Editor Setup:',
      '1. Open Zed Settings (Cmd+,) and go to the "assistant" section',
      '2. Add an MCP server entry:',
      '   {',
      '     "name": "nr-ai-observatory",',
      '     "command": "npx",',
      '     "args": ["nr-ai-mcp-server", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Restart Zed to activate.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.ZED_SESSION_ID !== undefined ||
      process.env.ZED_EXTENSION_API_VERSION !== undefined ||
      process.env.MCP_CLIENT === 'zed' ||
      process.env.ZED_ITEM_ID !== undefined
    );
  }
}
```

---

## Step 2 — ContinueAdapter

### Tool name mapping

Continue.dev uses VS Code language server and its own tool naming:

```typescript
const CONTINUE_TOOL_MAP: Record<string, string> = {
  // File operations (Continue built-in tools)
  readFile: 'Read',
  writeFile: 'Write',
  editFile: 'Edit',
  createFile: 'Write',
  deleteFile: 'Delete',
  // Search
  searchFiles: 'Glob',
  grep: 'Grep',
  grepSearch: 'Grep',
  fileSearch: 'Glob',
  // Terminal
  runTerminalCommand: 'Bash',
  terminal: 'Bash',
  // IDE interactions
  viewSubdirectory: 'Glob',
  viewRepoMap: 'Glob',
};
```

### Detection heuristics

Continue sets `CONTINUE_*` env vars or can be detected from the MCP client identifier:

```typescript
isSupported(): boolean {
  return (
    process.env.CONTINUE_SESSION_ID !== undefined ||
    process.env.CONTINUE_SERVER_HOST !== undefined ||
    process.env.MCP_CLIENT === 'continue' ||
    process.env.MCP_CLIENT_NAME === 'continue'
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const CONTINUE_TOOL_MAP: Record<string, string> = {
  readFile: 'Read',
  writeFile: 'Write',
  editFile: 'Edit',
  createFile: 'Write',
  deleteFile: 'Delete',
  searchFiles: 'Glob',
  grep: 'Grep',
  grepSearch: 'Grep',
  fileSearch: 'Glob',
  runTerminalCommand: 'Bash',
  terminal: 'Bash',
  viewSubdirectory: 'Glob',
  viewRepoMap: 'Glob',
};

interface ContinueToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filepath?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class ContinueAdapter implements PlatformAdapter {
  readonly platformName = 'continue';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Continue.dev communicates via MCP stdio or local HTTP server.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ContinueToolCallEvent;
    // Continue may use either 'tool' or 'toolName'
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = CONTINUE_TOOL_MAP[platformToolName] ?? 'Unknown';
    // Continue may use 'filepath' (lowercase p) or 'filePath'
    const filePath = event.filePath ?? event.filepath;

    return {
      toolName,
      platformToolName,
      platform: this.platformName,
      timestamp: event.timestamp ?? Date.now(),
      durationMs: event.durationMs ?? null,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(filePath !== undefined && { filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CONTINUE_VERSION && { ideVersion: process.env.CONTINUE_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Continue.dev Setup:',
      '1. Open Continue config file (~/.continue/config.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "name": "nr-ai-observatory",',
      '     "command": "npx",',
      '     "args": ["nr-ai-mcp-server", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Reload the Continue extension.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.CONTINUE_SESSION_ID !== undefined ||
      process.env.CONTINUE_SERVER_HOST !== undefined ||
      process.env.MCP_CLIENT === 'continue' ||
      process.env.MCP_CLIENT_NAME === 'continue'
    );
  }
}
```

---

## Step 3 — AmazonQAdapter

### Tool name mapping

Amazon Q Developer uses its own tool naming via the `amazon-q-developer` MCP integration:

```typescript
const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  // File operations
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  fs_create: 'Write',
  fs_delete: 'Delete',
  // Search
  fs_list: 'Glob',
  fs_find: 'Glob',
  grep: 'Grep',
  search_code: 'Grep',
  // Terminal
  execute_bash: 'Bash',
  run_shell: 'Bash',
  execute_command: 'Bash',
  // Amazon Q specific
  explain_code: 'Read',
  review_code: 'Read',
  transform_code: 'Edit',
};
```

### Detection heuristics

Amazon Q sets `AWS_*` and `Q_*` env vars:

```typescript
isSupported(): boolean {
  return (
    process.env.AMAZON_Q_SESSION_ID !== undefined ||
    process.env.Q_DEVELOPER_SESSION !== undefined ||
    process.env.MCP_CLIENT === 'amazon-q' ||
    process.env.AWS_CODEWHISPERER_SESSION !== undefined
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  fs_create: 'Write',
  fs_delete: 'Delete',
  fs_list: 'Glob',
  fs_find: 'Glob',
  grep: 'Grep',
  search_code: 'Grep',
  execute_bash: 'Bash',
  run_shell: 'Bash',
  execute_command: 'Bash',
  explain_code: 'Read',
  review_code: 'Read',
  transform_code: 'Edit',
};

interface AmazonQToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  path?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class AmazonQAdapter implements PlatformAdapter {
  readonly platformName = 'amazon-q';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Amazon Q Developer connects via the MCP stdio protocol.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as AmazonQToolCallEvent;
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = AMAZON_Q_TOOL_MAP[platformToolName] ?? 'Unknown';
    const filePath = event.filePath ?? event.path;

    return {
      toolName,
      platformToolName,
      platform: this.platformName,
      timestamp: event.timestamp ?? Date.now(),
      durationMs: event.durationMs ?? null,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(filePath !== undefined && { filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.AMAZON_Q_VERSION && { ideVersion: process.env.AMAZON_Q_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Amazon Q Developer Setup:',
      '1. Open your Amazon Q Developer MCP configuration file',
      '   (typically ~/.aws/amazonq/mcp.json or project-level .amazonq/mcp.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "nr-ai-observatory": {',
      '       "command": "npx",',
      '       "args": ["nr-ai-mcp-server", "--stdio"],',
      '       "env": {',
      '         "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '         "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '       }',
      '     }',
      '   }',
      '3. Restart Amazon Q Developer.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.AMAZON_Q_SESSION_ID !== undefined ||
      process.env.Q_DEVELOPER_SESSION !== undefined ||
      process.env.MCP_CLIENT === 'amazon-q' ||
      process.env.AWS_CODEWHISPERER_SESSION !== undefined
    );
  }
}
```

---

## Step 4 — Register all three adapters

Open `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts`.

### 4a — Add imports

```typescript
import { ZedAdapter } from './zed-adapter.js';
import { ContinueAdapter } from './continue-adapter.js';
import { AmazonQAdapter } from './amazon-q-adapter.js';
```

### 4b — Register in `createDefaultRegistry()`

Add the three new adapters **before** `GenericMcpAdapter` (which should always be last as the fallback):

```typescript
export function createDefaultRegistry(): PlatformRegistry {
  const registry = new PlatformRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CursorAdapter());
  registry.register(new WindsurfAdapter());
  registry.register(new CopilotAdapter());
  registry.register(new ZedAdapter());
  registry.register(new ContinueAdapter());
  registry.register(new AmazonQAdapter());
  registry.register(new GenericMcpAdapter()); // always last
  return registry;
}
```

---

## Step 5 — Export from `platforms/index.ts`

Open `packages/nr-ai-mcp-server/src/platforms/index.ts`. Add the three new exports:

```typescript
export { ZedAdapter } from './zed-adapter.js';
export { ContinueAdapter } from './continue-adapter.js';
export { AmazonQAdapter } from './amazon-q-adapter.js';
```

---

## Step 6 — Write tests

Create a test file for each adapter. Follow the exact structure of `cursor-adapter.test.ts`. Read that file before writing tests.

Each test file should cover:

### Tests per adapter (same structure for all three)

```typescript
describe('XxxAdapter', () => {
  let adapter: XxxAdapter;

  beforeEach(() => {
    adapter = new XxxAdapter();
  });

  describe('platformName', () => {
    it('is the correct platform identifier', () => {
      expect(adapter.platformName).toBe('<platform-name>');
    });
  });

  describe('normalizeToolCall()', () => {
    it('maps known tool names to shared vocabulary', () => {
      const result = adapter.normalizeToolCall({ tool: '<platform-read-tool>', success: true });
      expect(result.toolName).toBe('Read');
      expect(result.platform).toBe('<platform-name>');
    });

    it('uses "Unknown" for unmapped tool names', () => {
      const result = adapter.normalizeToolCall({ tool: 'some_mystery_tool', success: true });
      expect(result.toolName).toBe('Unknown');
    });

    it('defaults timestamp to now when not provided', () => {
      const before = Date.now();
      const result = adapter.normalizeToolCall({ tool: 'read_file', success: true });
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('passes through filePath when present', () => {
      const result = adapter.normalizeToolCall({ tool: 'read_file', filePath: '/foo/bar.ts' });
      expect(result.filePath).toBe('/foo/bar.ts');
    });

    it('passes through command when present', () => {
      const result = adapter.normalizeToolCall({ tool: 'execute_command', command: 'npm test' });
      expect(result.command).toBe('npm test');
    });
  });

  describe('isSupported()', () => {
    afterEach(() => {
      // Clean up env vars set in tests
      delete process.env.XXX_SESSION_ID;
      delete process.env.MCP_CLIENT;
    });

    it('returns true when detection env var is set', () => {
      process.env.XXX_SESSION_ID = 'test-session';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT matches', () => {
      process.env.MCP_CLIENT = '<platform-name>';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false when no detection signal present', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getSessionMetadata()', () => {
    it('returns the correct platform name', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('<platform-name>');
    });
  });

  describe('getHookInstallInstructions()', () => {
    it('returns a non-empty string', () => {
      expect(adapter.getHookInstallInstructions().length).toBeGreaterThan(0);
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });
  });
});
```

**For `ContinueAdapter` specifically**, add a test for the dual key normalization (`filepath` vs `filePath`):

```typescript
it('normalizes filepath (lowercase p) to filePath', () => {
  const result = adapter.normalizeToolCall({ tool: 'readFile', filepath: '/src/app.ts' });
  expect(result.filePath).toBe('/src/app.ts');
});
```

**For `AmazonQAdapter` specifically**, add a test for the `path` fallback:

```typescript
it('normalizes path to filePath', () => {
  const result = adapter.normalizeToolCall({ tool: 'fs_read', path: '/src/app.ts' });
  expect(result.filePath).toBe('/src/app.ts');
});
```

---

## Step 7 — Update platform registry test

Open `packages/nr-ai-mcp-server/src/platforms/platform-registry.test.ts`. Add a test that `createDefaultRegistry()` includes the new platforms:

```typescript
it('includes zed, continue, and amazon-q adapters', () => {
  const registry = createDefaultRegistry();
  const names = registry.getRegistered().map(a => a.platformName);
  expect(names).toContain('zed');
  expect(names).toContain('continue');
  expect(names).toContain('amazon-q');
});
```

Also ensure the registry still ends with `generic-mcp`:

```typescript
it('ends with generic-mcp as fallback', () => {
  const registry = createDefaultRegistry();
  const adapters = registry.getRegistered();
  expect(adapters[adapters.length - 1].platformName).toBe('generic-mcp');
});
```

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all three new adapter test files pass
- [ ] `createDefaultRegistry()` includes `zed`, `continue`, and `amazon-q` adapters
- [ ] `generic-mcp` is still last in the registry
- [ ] Each adapter's `normalizeToolCall()` maps at least 5 distinct tool names correctly
- [ ] `isSupported()` returns `false` when no detection env vars are set (important: clean up env in tests)
- [ ] `getHookInstallInstructions()` mentions `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID`
- [ ] All three adapters are exported from `platforms/index.ts`
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts
packages/nr-ai-mcp-server/src/platforms/zed-adapter.test.ts
packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts
packages/nr-ai-mcp-server/src/platforms/continue-adapter.test.ts
packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts
packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/platforms/platform-registry.ts — add 3 imports + registrations
packages/nr-ai-mcp-server/src/platforms/index.ts              — add 3 exports
packages/nr-ai-mcp-server/src/platforms/platform-registry.test.ts — add 2 registry tests
```
