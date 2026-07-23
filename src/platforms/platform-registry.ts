import { createLogger } from '../shared/index.js';
import type { PlatformAdapter, PlatformVisibilityLevel } from './types.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { WindsurfAdapter } from './windsurf-adapter.js';
import { CopilotAdapter } from './copilot-adapter.js';
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
import { GenericMcpAdapter } from './generic-mcp-adapter.js';

const logger = createLogger('platform-registry');

export class PlatformRegistry {
  private readonly adapters: PlatformAdapter[] = [];
  private active: PlatformAdapter | null = null;

  register(adapter: PlatformAdapter): void {
    this.adapters.push(adapter);
    logger.debug('Registered platform adapter', { platform: adapter.platformName });
  }

  detect(): PlatformAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.isSupported()) {
        this.active = adapter;
        logger.info('Detected platform', { platform: adapter.platformName });
        return adapter;
      }
    }

    logger.debug('No platform detected');
    return null;
  }

  getActive(): PlatformAdapter {
    if (this.active) return this.active;

    const detected = this.detect();
    if (detected) return detected;

    throw new Error(
      'No supported platform detected. Registered platforms: ' +
        this.adapters.map((a) => a.platformName).join(', '),
    );
  }

  getRegistered(): readonly PlatformAdapter[] {
    return this.adapters;
  }
}

export function createDefaultRegistry(): PlatformRegistry {
  const registry = new PlatformRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CursorAdapter());
  registry.register(new WindsurfAdapter());
  registry.register(new CopilotAdapter());
  registry.register(new ZedAdapter());
  registry.register(new ContinueAdapter());
  registry.register(new AmazonQAdapter());
  registry.register(new KiroAdapter());
  registry.register(new DroidAdapter());
  registry.register(new GeminiCliAdapter());
  registry.register(new ClineAdapter());
  registry.register(new CodexAdapter());
  registry.register(new OpencodeAdapter());
  registry.register(new KiloCodeAdapter());
  registry.register(new GenericMcpAdapter()); // always last
  return registry;
}

/**
 * Maps every known platform's `platformName` to its `visibilityLevel`, for
 * consumers (platform comparison, weekly summary) that need to tag or
 * caveat metrics blended across platforms with different instrumentation
 * coverage without instantiating a full registry themselves.
 */
export function getPlatformVisibilityMap(): ReadonlyMap<string, PlatformVisibilityLevel> {
  const registry = createDefaultRegistry();
  return new Map(
    registry.getRegistered().map((adapter) => [adapter.platformName, adapter.visibilityLevel]),
  );
}
