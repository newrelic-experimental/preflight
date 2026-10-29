import { describe, it, expect } from '@jest/globals';
import {
  generateKiroHooks,
  kiroHooksPath,
  mergeKiroHooksFile,
  removeKiroHooksFile,
} from './kiro-install-helper.js';

describe('kiro-install-helper', () => {
  it('places the hook file in the project .kiro/hooks directory', () => {
    expect(kiroHooksPath('/work/app')).toBe('/work/app/.kiro/hooks/preflight-observability.json');
  });

  it('emits pre and post hooks that stamp MCP_CLIENT=kiro on the command', () => {
    expect(generateKiroHooks()).toEqual([
      {
        name: 'Preflight: pre tool call',
        trigger: 'PreToolUse',
        action: { type: 'command', command: 'MCP_CLIENT=kiro preflight-collector' },
        timeout: 10,
      },
      {
        name: 'Preflight: post tool call',
        trigger: 'PostToolUse',
        action: { type: 'command', command: 'MCP_CLIENT=kiro preflight-collector' },
        timeout: 10,
      },
    ]);
  });

  it('creates a v1 file from an empty one', () => {
    const merged = mergeKiroHooksFile({});
    expect(merged.version).toBe('v1');
    expect(merged.hooks).toHaveLength(2);
  });

  it('is idempotent and keeps hooks it does not own', () => {
    const mine = {
      name: 'Lint on save',
      trigger: 'PostToolUse',
      action: { type: 'command', command: 'lint' },
    };
    const once = mergeKiroHooksFile({ version: 'v1', hooks: [mine] });
    const twice = mergeKiroHooksFile(once);
    expect(twice).toEqual(once);
    expect((twice.hooks as unknown[])[0]).toEqual(mine);
    expect(twice.hooks).toHaveLength(3);
  });

  it('removes only Preflight hooks and keeps the rest of the file', () => {
    const other = { name: 'Lint on save', trigger: 'PostToolUse' };
    const removed = removeKiroHooksFile(mergeKiroHooksFile({ version: 'v1', hooks: [other] }));
    expect(removed).toEqual({ version: 'v1', hooks: [other] });
  });
});
