import { describe, it, expect } from '@jest/globals';
import { isPlatformDetectionFellBack } from './platform-detection-health.js';

describe('isPlatformDetectionFellBack', () => {
  it('is true when the active platform is the generic MCP fallback', () => {
    expect(isPlatformDetectionFellBack('generic-mcp')).toBe(true);
  });

  it('is false for a named platform', () => {
    expect(isPlatformDetectionFellBack('claude-code')).toBe(false);
    expect(isPlatformDetectionFellBack('copilot-app')).toBe(false);
  });
});
