import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PlatformRegistry, createDefaultRegistry } from './platform-registry.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { WindsurfAdapter } from './windsurf-adapter.js';
import { CopilotAdapter } from './copilot-adapter.js';
import { GenericMcpAdapter } from './generic-mcp-adapter.js';
import { ZedAdapter } from './zed-adapter.js';
import { ContinueAdapter } from './continue-adapter.js';
import { AmazonQAdapter } from './amazon-q-adapter.js';
import { KiroAdapter } from './kiro-adapter.js';
import { DroidAdapter } from './droid-adapter.js';
import { GeminiCliAdapter } from './gemini-cli-adapter.js';
import { ClineAdapter } from './cline-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpencodeAdapter } from './opencode-adapter.js';
import { KiloCodeAdapter } from './kilo-code-adapter.js';
import type { PlatformAdapter, PlatformSessionMetadata, NormalizedToolCall } from './types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'CLAUDE_CODE',
  'CLAUDE_CODE_VERSION',
  'MCP_CLIENT',
  'MCP_CLIENT_NAME',
  'CURSOR_SESSION_ID',
  'CURSOR_TRACE_ID',
  'WINDSURF_SESSION_ID',
  'WINDSURF_CONTEXT_ID',
  'NEW_RELIC_AI_PLATFORM',
  'ZED_SESSION_ID',
  'ZED_EXTENSION_API_VERSION',
  'ZED_ITEM_ID',
  'CONTINUE_SESSION_ID',
  'CONTINUE_SERVER_HOST',
  'CONTINUE_VERSION',
  'AMAZON_Q_SESSION_ID',
  'Q_DEVELOPER_SESSION',
  'AWS_CODEWHISPERER_SESSION',
  'AMAZON_Q_VERSION',
  'KIRO_SESSION_ID',
  'KIRO_IDE',
  'KIRO_VERSION',
];

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
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
  readonly visibilityLevel = 'full-hooks' as const;
  readonly capabilities = { instructionFilePaths: [] };
  private readonly supported: boolean;

  constructor(name: string, supported: boolean) {
    this.platformName = name;
    this.supported = supported;
  }

  async initialize(): Promise<void> {}

  normalizeToolCall(): NormalizedToolCall {
    return {
      toolName: 'Test',
      platformToolName: 'test',
      platform: this.platformName,
      timestamp: Date.now(),
      durationMs: null,
      success: true,
    };
  }

  mapToolName(): string {
    return 'Test';
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

    it('preserves previously cached adapter when re-detect finds nothing', () => {
      let isSupported = true;
      const mutableAdapter: PlatformAdapter = {
        platformName: 'mutable',
        visibilityLevel: 'full-hooks',
        capabilities: { instructionFilePaths: [] },
        async initialize() {},
        normalizeToolCall() {
          return {
            toolName: 'T',
            platformToolName: 't',
            platform: 'mutable',
            timestamp: 0,
            durationMs: null,
            success: true,
          };
        },
        mapToolName() {
          return 'T';
        },
        getSessionMetadata() {
          return { platform: 'mutable' };
        },
        getHookInstallInstructions() {
          return '';
        },
        isSupported() {
          return isSupported;
        },
      };
      const registry = new PlatformRegistry();
      registry.register(mutableAdapter);

      registry.detect();
      isSupported = false;
      registry.detect();

      expect(registry.getActive().platformName).toBe('mutable');
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

    it('selects Copilot adapter when Copilot platform env is set', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'copilot';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('copilot');
    });

    it('selects Zed adapter when Zed env vars are present', () => {
      process.env.ZED_SESSION_ID = 'zed-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('zed');
    });

    it('selects Continue adapter when Continue env vars are present', () => {
      process.env.CONTINUE_SESSION_ID = 'cont-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('continue');
    });

    it('selects Amazon Q adapter when Amazon Q env vars are present', () => {
      process.env.AMAZON_Q_SESSION_ID = 'q-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('amazon-q');
    });

    it('selects Kiro adapter when Kiro env vars are present', () => {
      process.env.KIRO_SESSION_ID = 'kiro-abc';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('kiro');
    });

    it('selects Droid adapter when MCP_CLIENT is "droid"', () => {
      process.env.MCP_CLIENT = 'droid';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('droid');
    });

    it('selects Gemini CLI adapter when MCP_CLIENT is "gemini-cli"', () => {
      process.env.MCP_CLIENT = 'gemini-cli';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('gemini-cli');
    });

    it('selects Cline adapter when MCP_CLIENT is "cline"', () => {
      process.env.MCP_CLIENT = 'cline';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('cline');
    });

    it('selects Codex adapter when MCP_CLIENT is "codex"', () => {
      process.env.MCP_CLIENT = 'codex';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('codex');
    });

    it('selects opencode adapter when MCP_CLIENT is "opencode"', () => {
      process.env.MCP_CLIENT = 'opencode';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('opencode');
    });

    it('selects Kilo Code adapter when MCP_CLIENT is "kilocode"', () => {
      process.env.MCP_CLIENT = 'kilocode';
      const registry = createDefaultRegistry();

      const detected = registry.detect();
      expect(detected).not.toBeNull();
      expect(detected!.platformName).toBe('kilocode');
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

    expect(registered).toHaveLength(15);
    expect(registered[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect(registered[1]).toBeInstanceOf(CursorAdapter);
    expect(registered[2]).toBeInstanceOf(WindsurfAdapter);
    expect(registered[3]).toBeInstanceOf(CopilotAdapter);
    expect(registered[4]).toBeInstanceOf(ZedAdapter);
    expect(registered[5]).toBeInstanceOf(ContinueAdapter);
    expect(registered[6]).toBeInstanceOf(AmazonQAdapter);
    expect(registered[7]).toBeInstanceOf(KiroAdapter);
    expect(registered[8]).toBeInstanceOf(DroidAdapter);
    expect(registered[9]).toBeInstanceOf(GeminiCliAdapter);
    expect(registered[10]).toBeInstanceOf(ClineAdapter);
    expect(registered[11]).toBeInstanceOf(CodexAdapter);
    expect(registered[12]).toBeInstanceOf(OpencodeAdapter);
    expect(registered[13]).toBeInstanceOf(KiloCodeAdapter);
    expect(registered[14]).toBeInstanceOf(GenericMcpAdapter);
  });

  it('includes zed, continue, amazon-q, kiro, droid, gemini-cli, cline, codex, opencode, and kilocode adapters', () => {
    const registry = createDefaultRegistry();
    const names = registry.getRegistered().map((a) => a.platformName);
    expect(names).toContain('zed');
    expect(names).toContain('continue');
    expect(names).toContain('amazon-q');
    expect(names).toContain('kiro');
    expect(names).toContain('droid');
    expect(names).toContain('gemini-cli');
    expect(names).toContain('cline');
    expect(names).toContain('codex');
    expect(names).toContain('opencode');
    expect(names).toContain('kilocode');
  });

  it('ends with generic-mcp as fallback', () => {
    const registry = createDefaultRegistry();
    const adapters = registry.getRegistered();
    expect(adapters[adapters.length - 1].platformName).toBe('generic-mcp');
  });
});

describe('visibility level', () => {
  const VALID_LEVELS = new Set(['full-hooks', 'self-reported', 'mcp-tools-only']);

  it('every registered adapter declares a valid visibilityLevel', () => {
    const registry = createDefaultRegistry();
    for (const adapter of registry.getRegistered()) {
      expect(VALID_LEVELS.has(adapter.visibilityLevel)).toBe(true);
    }
  });
});

describe('capabilities', () => {
  it('every registered adapter declares a capabilities object with an array of instructionFilePaths', () => {
    const registry = createDefaultRegistry();
    for (const adapter of registry.getRegistered()) {
      expect(adapter.capabilities).toBeDefined();
      expect(Array.isArray(adapter.capabilities.instructionFilePaths)).toBe(true);
    }
  });

  it('claude-code declares CLAUDE.md and .claude/ as instruction file paths', () => {
    const registry = createDefaultRegistry();
    const claudeCode = registry.getRegistered().find((a) => a.platformName === 'claude-code')!;
    expect(claudeCode.capabilities.instructionFilePaths).toEqual(['CLAUDE.md', '.claude/']);
  });

  it('cursor declares .cursorrules as an instruction file path', () => {
    const registry = createDefaultRegistry();
    const cursor = registry.getRegistered().find((a) => a.platformName === 'cursor')!;
    expect(cursor.capabilities.instructionFilePaths).toContain('.cursorrules');
  });

  it('windsurf declares .windsurfrules as an instruction file path', () => {
    const registry = createDefaultRegistry();
    const windsurf = registry.getRegistered().find((a) => a.platformName === 'windsurf')!;
    expect(windsurf.capabilities.instructionFilePaths).toContain('.windsurfrules');
  });

  it('droid declares AGENTS.md as an instruction file path', () => {
    const registry = createDefaultRegistry();
    const droid = registry.getRegistered().find((a) => a.platformName === 'droid')!;
    expect(droid.capabilities.instructionFilePaths).toContain('AGENTS.md');
  });

  it('gemini-cli declares GEMINI.md as an instruction file path', () => {
    const registry = createDefaultRegistry();
    const geminiCli = registry.getRegistered().find((a) => a.platformName === 'gemini-cli')!;
    expect(geminiCli.capabilities.instructionFilePaths).toContain('GEMINI.md');
  });

  it('cline declares .clinerules/ as an instruction file path', () => {
    const registry = createDefaultRegistry();
    const cline = registry.getRegistered().find((a) => a.platformName === 'cline')!;
    expect(cline.capabilities.instructionFilePaths).toContain('.clinerules/');
  });
});

describe('all adapters implement PlatformAdapter interface', () => {
  const adapters: PlatformAdapter[] = [
    new ClaudeCodeAdapter(),
    new CursorAdapter(),
    new WindsurfAdapter(),
    new CopilotAdapter(),
    new ZedAdapter(),
    new ContinueAdapter(),
    new AmazonQAdapter(),
    new KiroAdapter(),
    new DroidAdapter(),
    new GeminiCliAdapter(),
    new ClineAdapter(),
    new CodexAdapter(),
    new OpencodeAdapter(),
    new KiloCodeAdapter(),
    new GenericMcpAdapter(),
  ];

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
