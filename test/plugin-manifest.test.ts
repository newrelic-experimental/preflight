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

const kiroPluginManifest: { version: string } = JSON.parse(
  readFileSync(resolve(repoRoot, 'kiro-power/plugin.json'), 'utf-8'),
);

// Vendored copy of https://agent-plugins.org/schemas/1.0.0/plugin.schema.json,
// the schema kiro-power/plugin.json names in `$schema`. Vendored so the test
// needs no network; the repo has no JSON Schema validator dependency, so
// validateAgainstSchema() below implements only the keywords this schema uses.
const agentPluginsSchema: JsonSchema = JSON.parse(
  readFileSync(resolve(repoRoot, 'test/fixtures/agent-plugins-1.0.0-plugin.schema.json'), 'utf-8'),
);

interface JsonSchema {
  readonly type?: 'object' | 'string' | 'array';
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly const?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'const',
  'minLength',
  'maxLength',
  'pattern',
]);

function unsupportedKeywords(schema: JsonSchema, path = '#'): string[] {
  const found = Object.keys(schema)
    .filter((k) => !SUPPORTED_KEYWORDS.has(k))
    .map((k) => `${path}/${k}`);
  const children: Array<[string, JsonSchema]> = [
    ...Object.entries(schema.properties ?? {}).map(([k, s]): [string, JsonSchema] => [
      `${path}/properties/${k}`,
      s,
    ]),
    ...(schema.items ? [[`${path}/items`, schema.items] as [string, JsonSchema]] : []),
    ...(typeof schema.additionalProperties === 'object'
      ? [[`${path}/additionalProperties`, schema.additionalProperties] as [string, JsonSchema]]
      : []),
  ];
  return found.concat(children.flatMap(([p, s]) => unsupportedKeywords(s, p)));
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [...errors, `${path} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} is shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} is longer than ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path} does not match ${schema.pattern}`);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${path} must be an array`];
    if (schema.items) {
      const items = schema.items;
      value.forEach((v, i) => errors.push(...validateAgainstSchema(v, items, `${path}[${i}]`)));
    }
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [...errors, `${path} must be an object`];
    }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path} is missing required key ${key}`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        errors.push(...validateAgainstSchema(v, propSchema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path} has unknown key ${key}`);
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(v, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }
  return errors;
}

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

  it('kiro-power/plugin.json version stays in sync with package.json', () => {
    // Not auto-synced (no registry/publish step reads it) — this went two
    // releases stale (1.36.0, 1.37.0) with nothing catching it before this
    // test existed. See CLAUDE.md and .github/workflows/release.yml's
    // "Verify manifest versions are in sync" gate for the release-time half
    // of this check.
    expect(kiroPluginManifest.version).toBe(packageJson.version);
  });

  it('the vendored Agent Plugins schema uses only keywords the local validator implements', () => {
    // A schema update that adds e.g. `enum` or `oneOf` would otherwise be
    // silently ignored by validateAgainstSchema().
    expect(unsupportedKeywords(agentPluginsSchema)).toEqual([]);
  });

  it('kiro-power/plugin.json validates against the Agent Plugins 1.0.0 schema', () => {
    // The schema is `additionalProperties: false` at the root, so any
    // host-specific key has to live under `extensions` (issue #792).
    expect(validateAgainstSchema(kiroPluginManifest, agentPluginsSchema)).toEqual([]);
  });

  it('the local schema validator rejects an unknown root key', () => {
    expect(
      validateAgainstSchema(
        { ...kiroPluginManifest, displayName: 'Preflight' },
        agentPluginsSchema,
      ),
    ).toEqual(['$ has unknown key displayName']);
  });
});
