import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { CopilotAppAdapter } from './copilot-app-adapter.js';

const ENV_KEYS = ['NEW_RELIC_AI_PLATFORM', 'MCP_CLIENT', 'NEW_RELIC_AI_COPILOT_DIR'];
const savedEnv: Record<string, string | undefined> = {};

let tmpDir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = resolve(
    tmpdir(),
    `nr-copilot-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // A real machine can have a real ~/.copilot/data.db (this one included),
  // which would otherwise make ambient detection fire for every test that
  // doesn't care about it. Point at a nonexistent dir by default; tests that
  // exercise ambient detection override this explicitly.
  process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('CopilotAppAdapter', () => {
  const adapter = new CopilotAppAdapter();

  it('has platformName "copilot-app"', () => {
    expect(adapter.platformName).toBe('copilot-app');
  });

  it('has visibilityLevel "full-hooks"', () => {
    expect(adapter.visibilityLevel).toBe('full-hooks');
  });

  it('has instructionFilePaths for AGENTS.md, CLAUDE.md, GEMINI.md, and .github/copilot-instructions.md', () => {
    expect(adapter.capabilities.instructionFilePaths).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
    ]);
  });

  describe('normalizeToolCall', () => {
    it('reads platform tool name from "tool" field', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'Bash', timestamp: 5000 });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.platformToolName).toBe('Bash');
      expect(normalized.platform).toBe('copilot-app');
    });

    it('reads platform tool name from "toolName" field', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'Edit', timestamp: 5000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('falls back to "unknown" when no tool name field is present', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 5000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
    });

    it('falls back to safe defaults when raw is not an object', () => {
      const normalized = adapter.normalizeToolCall(null);
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.platform).toBe('copilot-app');
      expect(normalized.success).toBe(true);
      expect(normalized.durationMs).toBeNull();
    });

    it('preserves the original name for app-level operations with no Claude equivalent', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'rename_session', timestamp: 5000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('rename_session');
    });

    it('includes command, sessionId, inputSizeBytes, outputSizeBytes', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'Bash',
        command: 'npm test',
        sessionId: 'copilot-app-sess-1',
        inputSizeBytes: 10,
        outputSizeBytes: 20,
      });
      expect(normalized.command).toBe('npm test');
      expect(normalized.sessionId).toBe('copilot-app-sess-1');
      expect(normalized.inputSizeBytes).toBe(10);
      expect(normalized.outputSizeBytes).toBe(20);
    });
  });

  describe('mapToolName', () => {
    // Canonical Claude-shaped names — what the pooled Copilot CLI's
    // PascalCase PreToolUse/PostToolUse hooks actually deliver.
    it.each([
      ['Bash', 'Bash'],
      ['Read', 'Read'],
      ['Edit', 'Edit'],
      ['Grep', 'Grep'],
      ['Glob', 'Glob'],
    ])('maps canonical name "%s" to "%s" (identity)', (platformToolName, expected) => {
      expect(adapter.mapToolName(platformToolName)).toBe(expected);
    });

    it('returns "Unknown" for the app-level operations rename_session and rename_branch', () => {
      expect(adapter.mapToolName('rename_session')).toBe('Unknown');
      expect(adapter.mapToolName('rename_branch')).toBe('Unknown');
    });

    it('returns "Unknown" for a tool with no Claude equivalent', () => {
      expect(adapter.mapToolName('totally_made_up')).toBe('Unknown');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "copilot-app"', () => {
      expect(adapter.getSessionMetadata().platform).toBe('copilot-app');
    });
  });

  describe('isSupported', () => {
    it('returns true when NEW_RELIC_AI_PLATFORM is "copilot-app"', () => {
      process.env.NEW_RELIC_AI_PLATFORM = 'copilot-app';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "copilot-app"', () => {
      process.env.MCP_CLIENT = 'copilot-app';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false for the copilot-sdk value (distinct platform)', () => {
      process.env.MCP_CLIENT = 'copilot-sdk';
      expect(adapter.isSupported()).toBe(false);
    });

    describe('ambient detection via NEW_RELIC_AI_COPILOT_DIR', () => {
      it('returns true when the dir has data.db and no session-state/ (fresh app install, before first session)', () => {
        mkdirSync(tmpDir, { recursive: true });
        writeFileSync(join(tmpDir, 'data.db'), '');
        process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;

        expect(adapter.isSupported()).toBe(true);
      });

      it('returns true when the dir has both data.db and session-state/ (app machine after first session — session-state/ is created by the app itself and is not a valid discriminator)', () => {
        mkdirSync(tmpDir, { recursive: true });
        writeFileSync(join(tmpDir, 'data.db'), '');
        mkdirSync(join(tmpDir, 'session-state'), { recursive: true });
        process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;

        expect(adapter.isSupported()).toBe(true);
      });

      it('returns false when the dir does not exist', () => {
        process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;

        expect(adapter.isSupported()).toBe(false);
      });

      it('returns false when the dir exists but has no data.db (CLI-only machine)', () => {
        mkdirSync(tmpDir, { recursive: true });
        process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;

        expect(adapter.isSupported()).toBe(false);
      });

      it('returns false when data.db has not been written in over 7 days (app uninstalled or abandoned — bare existence is sticky forever)', () => {
        mkdirSync(tmpDir, { recursive: true });
        const dbPath = join(tmpDir, 'data.db');
        writeFileSync(dbPath, '');
        const staleSeconds = (Date.now() - 8 * 24 * 3_600_000) / 1000;
        utimesSync(dbPath, staleSeconds, staleSeconds);
        process.env.NEW_RELIC_AI_COPILOT_DIR = tmpDir;

        expect(adapter.isSupported()).toBe(false);
      });
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty instructions stamping MCP_CLIENT=copilot-app', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('MCP_CLIENT=copilot-app');
    });

    it('includes a "version": 1 field in the sample hooks JSON', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('"version": 1,');
    });

    it('mentions there is no extensions/ mechanism on this host', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions).toContain('extensions/');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
