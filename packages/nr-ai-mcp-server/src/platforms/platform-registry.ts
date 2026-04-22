import { createLogger } from '@nr-ai-observatory/shared';
import type { PlatformAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { WindsurfAdapter } from './windsurf-adapter.js';
import { CopilotAdapter } from './copilot-adapter.js';
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
  registry.register(new GenericMcpAdapter());
  return registry;
}
