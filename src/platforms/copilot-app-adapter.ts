import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { COPILOT_SDK_TOOL_MAP } from './copilot-sdk-adapter.js';
import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Two app-level operations, observed live on the GitHub Copilot desktop app
 * (macOS, v1.1.14, 2026-09-01), that have no Claude-tool equivalent and are
 * therefore deliberately absent from COPILOT_SDK_TOOL_MAP: `rename_session`
 * and `rename_branch`. mapToolName()'s `?? 'Unknown'` fallback still
 * preserves the original platformToolName downstream (see
 * normalizeToolCall()'s platformToolName field) — they are unmapped, not
 * dropped.
 */

interface CopilotAppToolCallEvent {
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
}

function isCopilotAppToolCallEvent(x: unknown): x is CopilotAppToolCallEvent {
  return typeof x === 'object' && x !== null;
}

/** How recently `data.db` must have been written for ambient detection — see isSupported(). */
const AMBIENT_DB_RECENCY_MS = 7 * 24 * 3_600_000;

/**
 * Resolves the app's `~/.copilot`-shaped directory. The env override exists
 * for tests and non-default installs, and keeps ambient detection
 * deterministic on machines that really have the app installed (see
 * isSupported() below).
 */
export function getCopilotAppDir(): string {
  return process.env.NEW_RELIC_AI_COPILOT_DIR ?? join(homedir(), '.copilot');
}

/**
 * Adapter for the GitHub Copilot desktop app — a Rust GUI over a warm pool of
 * Copilot CLI stdio processes (empirically verified: macOS, Copilot app
 * v1.1.14, 2026-09-01). Distinct from `CopilotSdkAdapter`'s confirmed host
 * (the standalone Copilot CLI): the app shares the CLI's `~/.copilot`
 * directory name but keeps its own `data.db` SQLite store (its session/
 * economics store, schema v100) that the standalone CLI's documented config
 * dir never creates — the discriminator ambient detection below relies on.
 * Note `session-state/` is NOT a usable discriminator despite being in the
 * CLI's docs: the app's own pooled CLI processes create it too, after the
 * first session (verified live 2026-08-31 — the dir held exactly the app's
 * own session ids), so its absence would misclassify any machine that has
 * run one app session as "not the app".
 */
export class CopilotAppAdapter implements PlatformAdapter {
  readonly platformName = 'copilot-app';
  // Every built-in tool call is captured automatically: the pooled Copilot
  // CLI processes fire the same PascalCase PreToolUse/PostToolUse hooks
  // CopilotSdkAdapter depends on, already canonicalized to Claude-shaped tool
  // names — empirically verified as above.
  readonly visibilityLevel = 'full-hooks' as const;
  // Same list as CopilotSdkAdapter: the app spawns its pooled CLI with
  // enable_config_discovery=true (observed in the app's own lifecycle logs),
  // so the CLI's documented custom-instructions locations
  // (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions#custom-instructions-locations)
  // apply unchanged.
  readonly capabilities = {
    instructionFilePaths: [
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
    ] as const,
  };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Tool calls arrive via the pooled Copilot CLI's hooks (collector
    // script), parsed by collector-script.ts's uniform branch — same path as
    // CopilotSdkAdapter.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = isCopilotAppToolCallEvent(raw) ? raw : {};
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = COPILOT_SDK_TOOL_MAP[platformToolName] ?? 'Unknown';
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

  mapToolName(platformToolName: string): string {
    return COPILOT_SDK_TOOL_MAP[platformToolName] ?? 'Unknown';
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
    };
  }

  getHookInstallInstructions(): string {
    return [
      'GitHub Copilot (desktop app) Setup:',
      '1. Create a hooks file to enable tool-call capture:',
      '   ~/.copilot/hooks/preflight.json:',
      '   {',
      '     "version": 1,',
      '     "hooks": {',
      '       "PreToolUse": [{ "type": "command", "command": "MCP_CLIENT=copilot-app preflight-collector pre-tool" }],',
      '       "PostToolUse": [{ "type": "command", "command": "MCP_CLIENT=copilot-app preflight-collector post-tool" }]',
      '     }',
      '   }',
      '2. Ensure preflight-collector is on PATH (npm link, or npm install -g',
      '   @newrelic/preflight) — the app resolves hook commands through your',
      '   login shell, so PATH entries only visible in interactive shell',
      '   startup files may not apply.',
      '3. Register the Preflight MCP server:',
      '   copilot mcp add preflight \\',
      '     --env MCP_CLIENT=copilot-app \\',
      '     --env NEW_RELIC_LICENSE_KEY=<your-key> \\',
      '     --env NEW_RELIC_ACCOUNT_ID=<your-account-id> \\',
      '     -- npx preflight --stdio',
      '4. There is no extensions/ mechanism on this host — the Rust app',
      '   cannot load the copilot-sdk .mjs extension CopilotSdkAdapter uses',
      "   for token-exact cost. That data instead comes from the app's own",
      '   ~/.copilot/data.db SQLite store, read automatically by',
      '   CopilotAppUsageWatcher inside the Preflight MCP/dashboard process.',
    ].join('\n');
  }

  isSupported(): boolean {
    if (
      process.env.MCP_CLIENT === 'copilot-app' ||
      process.env.NEW_RELIC_AI_PLATFORM === 'copilot-app'
    ) {
      return true;
    }

    // Ambient detection: `data.db` is created only by the desktop app's Rust
    // GUI (its session/economics store, schema v100) — the standalone
    // Copilot CLI's documented config dir has no such file. `session-state/`
    // is NOT usable as a discriminator: it's created by the app's own pooled
    // CLI processes after the first session too (verified live 2026-08-31),
    // so its presence or absence says nothing about which host this is.
    // Bare existence is sticky forever (uninstalling the app leaves data.db
    // behind), so the file must also be recently modified — the app writes
    // it continuously while running, and a machine that stopped using the
    // app ages out of ambient detection instead of misclassifying every
    // later un-stamped session as copilot-app indefinitely.
    const dir = getCopilotAppDir();
    try {
      const st = statSync(join(dir, 'data.db'));
      return Date.now() - st.mtimeMs <= AMBIENT_DB_RECENCY_MS;
    } catch {
      return false;
    }
  }
}
