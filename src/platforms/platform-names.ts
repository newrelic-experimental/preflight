export const PLATFORM_NAMES = [
  'claude-code',
  'cursor',
  'windsurf',
  'copilot',
  'copilot-app',
  'copilot-sdk',
  'zed',
  'continue',
  'amazon-q',
  'kiro',
  'droid',
  'gemini-cli',
  'cline',
  'codex',
  'opencode',
  'kilocode',
  'pi',
  'antigravity',
  'generic-mcp',
] as const;

type PlatformName = (typeof PLATFORM_NAMES)[number];

export const ENGINE_ENV_KEYS = ['MCP_CLIENT', 'NEW_RELIC_AI_PLATFORM'] as const;

const aliasKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const PLATFORM_BY_ALIAS = new Map<string, PlatformName>(
  PLATFORM_NAMES.map((n) => [aliasKey(n), n]),
);

export function canonicalPlatformName(name: string | undefined): PlatformName | undefined {
  return name ? PLATFORM_BY_ALIAS.get(aliasKey(name)) : undefined;
}

export function normalizeEngineEnv(env: NodeJS.ProcessEnv): void {
  for (const key of ENGINE_ENV_KEYS) {
    const name = canonicalPlatformName(env[key]);
    if (name !== undefined) env[key] = name;
  }
}
