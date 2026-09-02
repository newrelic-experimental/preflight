import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

const packageJson: { version: string } = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
);

const marketplace: {
  name: string;
  plugins: Array<{ name: string; source: string; description: string }>;
} = JSON.parse(readFileSync(resolve(repoRoot, '.claude-plugin/marketplace.json'), 'utf-8'));

const pluginManifest: {
  name: string;
  version: string;
  mcpServers: string;
} = JSON.parse(readFileSync(resolve(repoRoot, 'plugin/.claude-plugin/plugin.json'), 'utf-8'));

const mcpConfig: {
  mcpServers: Record<string, { command: string; args: string[] }>;
} = JSON.parse(readFileSync(resolve(repoRoot, 'plugin/.mcp.json'), 'utf-8'));

const hooksConfig: {
  hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] };
} = JSON.parse(readFileSync(resolve(repoRoot, 'plugin/hooks/hooks.json'), 'utf-8'));

describe('Claude Code plugin manifests', () => {
  it('marketplace.json lists the plugin pointing at ./plugin', () => {
    const entry = marketplace.plugins.find((p) => p.name === pluginManifest.name);
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('./plugin');
  });

  it('plugin.json version stays in sync with package.json', () => {
    // Not auto-synced (docs/PLUGIN.md) — this test exists to catch drift
    // that would otherwise only surface at release time.
    expect(pluginManifest.version).toBe(packageJson.version);
  });

  it('plugin.json references an existing MCP config file', () => {
    expect(pluginManifest.mcpServers).toBe('./.mcp.json');
    expect(existsSync(resolve(repoRoot, 'plugin/.mcp.json'))).toBe(true);
  });

  it('.mcp.json launches the published package over stdio', () => {
    const server = mcpConfig.mcpServers['newrelic-preflight'];
    expect(server).toBeDefined();
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@newrelic/preflight@latest', '--stdio']);
  });

  it('hooks.json wires both PreToolUse and PostToolUse to the bundled collector', () => {
    expect(hooksConfig.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(hooksConfig.hooks.PostToolUse.length).toBeGreaterThan(0);
  });

  it('the bundled hook collector script exists and is committed', () => {
    expect(existsSync(resolve(repoRoot, 'plugin/.claude-plugin/scripts/collector-script.js'))).toBe(
      true,
    );
  });
});
