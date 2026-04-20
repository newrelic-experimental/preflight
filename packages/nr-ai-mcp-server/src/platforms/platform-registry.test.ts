import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PlatformRegistry, createDefaultRegistry } from './platform-registry.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { WindsurfAdapter } from './windsurf-adapter.js';
import { CopilotAdapter } from './copilot-adapter.js';
import { GenericMcpAdapter } from './generic-mcp-adapter.js';
import type { PlatformAdapter, PlatformConfig, PlatformSessionMetadata, NormalizedToolCall } from './types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'CLAUDE_CODE', 'CLAUDE_CODE_VERSION', 'MCP_CLIENT',
  'CURSOR_SESSION_ID', 'CURSOR_TRACE_ID',
  'WINDSURF_SESSION_ID', 'WINDSURF_CONTEXT_ID',
  'NR_AI_COPILOT_OBSERVER',
];

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class FakeAdapter implements PlatformAdapter {
  readonly platformName: string;
  private readonly supported: boolean;

  constructor(name: string, supported: boolean) {
    this.platformName = name;
    this.supported = supported;
  }

  async initialize(_config: PlatformConfig): Promise<void> {}

  normalizeToolCall(_raw: unknown): NormalizedToolCall {
    return {
      toolName: 'Test',
      platformToolName: 'test',
      platform: this.platformName,
      timestamp: Date.now(),
      durationMs: null,
      success: true,
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return { platform: this.platformName };
  }

  getHookInstallInstructions(): string {
    return `Install ${this.platformName}`;
  }

  isSupported(): boolean {
    return this.supported;
  }
}

describe('PlatformRegistry', () => {
  describe('register and getRegistered', () => {
    it('registers adapters and returns them in order', () => {
      const registry = new PlatformRegistry();
      const a = new FakeAdapter('alpha', false);
      const b = new FakeAdapter('beta', false);

      registry.register(a);
      registry.register(b);

      const registered = registry.getRegistered();
      expect(registered).toHaveLength(2);
      expect(registered[0].platformName).toBe('alpha');
      expect(registered[1].platformName).toBe('beta');
    });
  });

  describe('detect', () => {
    it('returns first supported adapter', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('unsupported', false));
      registry.register(new FakeAdapter('supported', true));
      registry.register(new FakeAdapter('also-supported', true));

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('supported');
    });

    it('returns null when no adapter is supported', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('a', false));
      registry.register(new FakeAdapter('b', false));

      expect(registry.detect()).toBeNull();
    });

    it('returns null for an empty registry', () => {
      const registry = new PlatformRegistry();
      expect(registry.detect()).toBeNull();
    });

    it('correctly identifies Claude Code from env signals', () => {
      process.env.CLAUDE_CODE_VERSION = '1.0.0';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('claude-code');
    });

    it('selects Cursor adapter when Cursor env vars are present', () => {
      process.env.CURSOR_SESSION_ID = 'sess-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('cursor');
    });

    it('selects Windsurf adapter when Windsurf env vars are present', () => {
      process.env.WINDSURF_SESSION_ID = 'ws-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('windsurf');
    });

    it('prioritizes Claude Code over Cursor when both are present', () => {
      process.env.CLAUDE_CODE = '1';
      process.env.CURSOR_SESSION_ID = 'sess-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('claude-code');
    });

    it('selects Copilot adapter when Copilot extension env is present', () => {
      process.env.NR_AI_COPILOT_OBSERVER = 'active';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('copilot');
    });

    it('falls back to generic-mcp when no specific platform detected', () => {
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('generic-mcp');
    });

    it('prioritizes Cursor over Windsurf when both are present', () => {
      process.env.CURSOR_SESSION_ID = 'sess-abc';
      process.env.WINDSURF_SESSION_ID = 'ws-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('cursor');
    });
  });

  describe('getActive', () => {
    it('returns detected adapter', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('active', true));

      expect(registry.getActive().platformName).toBe('active');
    });

    it('caches detection result', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('first', true));

      const first = registry.getActive();
      const second = registry.getActive();
      expect(first).toBe(second);
    });

    it('throws when no platform is detected', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('unsupported', false));

      expect(() => registry.getActive()).toThrow('No supported platform detected');
    });

    it('throws with registered platform names in the error', () => {
      const registry = new PlatformRegistry();
      registry.register(new FakeAdapter('alpha', false));
      registry.register(new FakeAdapter('beta', false));

      expect(() => registry.getActive()).toThrow('alpha, beta');
    });
  });
});

describe('createDefaultRegistry', () => {
  it('pre-registers all platform adapters in priority order', () => {
    const registry = createDefaultRegistry();
    const registered = registry.getRegistered();

    expect(registered).toHaveLength(5);
    expect(registered[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect(registered[1]).toBeInstanceOf(CursorAdapter);
    expect(registered[2]).toBeInstanceOf(WindsurfAdapter);
    expect(registered[3]).toBeInstanceOf(CopilotAdapter);
    expect(registered[4]).toBeInstanceOf(GenericMcpAdapter);
  });
});

describe('all adapters implement PlatformAdapter interface', () => {
  const adapters: PlatformAdapter[] = [new ClaudeCodeAdapter(), new CursorAdapter(), new WindsurfAdapter(), new CopilotAdapter(), new GenericMcpAdapter()];

  for (const adapter of adapters) {
    describe(adapter.platformName, () => {
      it('has a non-empty platformName', () => {
        expect(adapter.platformName.length).toBeGreaterThan(0);
      });

      it('initialize returns a promise', () => {
        expect(adapter.initialize({})).toBeInstanceOf(Promise);
      });

      it('normalizeToolCall returns a NormalizedToolCall', () => {
        const result = adapter.normalizeToolCall({ tool: 'test', timestamp: 1000, success: true });
        expect(result).toHaveProperty('toolName');
        expect(result).toHaveProperty('platformToolName');
        expect(result).toHaveProperty('platform');
        expect(result).toHaveProperty('timestamp');
        expect(result).toHaveProperty('success');
      });

      it('getSessionMetadata returns metadata with platform', () => {
        const meta = adapter.getSessionMetadata();
        expect(meta.platform).toBe(adapter.platformName);
      });

      it('getHookInstallInstructions returns non-empty string', () => {
        expect(adapter.getHookInstallInstructions().length).toBeGreaterThan(0);
      });

      it('isSupported returns a boolean', () => {
        expect(typeof adapter.isSupported()).toBe('boolean');
      });
    });
  }
});
