import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateHookEntries } from '../src/install/install-helper.js';

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

interface HookGroup {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

const hooksConfig: {
  hooks: Record<string, HookGroup[]>;
} = JSON.parse(readFileSync(resolve(repoRoot, 'plugin/hooks/hooks.json'), 'utf-8'));

const kiroPluginManifest: { version: string } = JSON.parse(
  readFileSync(resolve(repoRoot, 'kiro-power/plugin.json'), 'utf-8'),
);

// Vendored copy of https://agent-plugins.org/schemas/1.0.0/plugin.schema.json,
// the schema kiro-power/plugin.json names in `$schema` (byte-identical to that
// URL when last checked, 2026-10-01). Vendored so the test needs no network;
// the repo has no JSON Schema validator dependency, so validateAgainstSchema()
// below implements only the keywords this schema uses.
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

// Test schemas go through the same unchecked JSON.parse as the vendored one,
// so they can carry values the JsonSchema type does not admit.
function parseSchema(json: string): JsonSchema {
  return JSON.parse(json);
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

const IMPLEMENTED_TYPES = new Set(['object', 'string', 'array']);

// validateAgainstSchema() applies each of these only inside the branch for
// the node's own `type`, so on a node without that type it does nothing.
const KEYWORD_TYPES = new Map([
  ['properties', 'object'],
  ['required', 'object'],
  ['additionalProperties', 'object'],
  ['items', 'array'],
  ['minLength', 'string'],
  ['maxLength', 'string'],
  ['pattern', 'string'],
]);

function unsupportedKeywords(schema: JsonSchema, path = '#'): string[] {
  // A boolean subschema (`true`/`false`) is valid 2020-12, but
  // validateAgainstSchema() treats it as an empty schema and accepts anything.
  const node: unknown = schema;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return [`${path}: non-object subschema ${JSON.stringify(node)}`];
  }
  const found = Object.keys(schema).flatMap((k) => {
    if (!SUPPORTED_KEYWORDS.has(k)) return [`${path}/${k}`];
    const neededType = KEYWORD_TYPES.get(k);
    return neededType !== undefined && schema.type !== neededType
      ? [`${path}/${k} without type ${JSON.stringify(neededType)}`]
      : [];
  });
  if (schema.type !== undefined && !IMPLEMENTED_TYPES.has(schema.type)) {
    found.push(`${path}/type: ${JSON.stringify(schema.type)}`);
  }
  const children: Array<[string, JsonSchema]> = [
    ...Object.entries(schema.properties ?? {}).map(([k, s]): [string, JsonSchema] => [
      `${path}/properties/${k}`,
      s,
    ]),
    ...(schema.items !== undefined
      ? [[`${path}/items`, schema.items] as [string, JsonSchema]]
      : []),
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
    // Own-property checks only: the value and the `properties` map both come
    // from JSON.parse and inherit Object.prototype, so `key in obj` or
    // `properties[key]` would resolve a key like `constructor` to an
    // inherited member instead of treating it as missing or unknown.
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(obj, key)) errors.push(`${path} is missing required key ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateAgainstSchema(v, properties[key], `${path}.${key}`));
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

  it('hooks.json wires the same events, matchers, and subcommands as preflight install', () => {
    const shape = (entries: Record<string, HookGroup[]>) =>
      Object.fromEntries(
        Object.entries(entries)
          .map(([event, groups]) => [
            event,
            groups.map((group) => ({
              matcher: group.matcher,
              subcommands: group.hooks.map((hook) => hook.command.trim().split(/\s+/).pop()),
            })),
          ])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      );

    expect(shape(hooksConfig.hooks)).toEqual(shape(generateHookEntries()));
  });

  it('every hooks.json command invokes the bundled collector', () => {
    const commands = Object.values(hooksConfig.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
    for (const command of commands) {
      expect(command).toMatch(
        /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/\.claude-plugin\/scripts\/collector-script\.js" [a-z-]+$/,
      );
    }
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

  it('the vendored Agent Plugins schema uses only keywords and types the local validator implements', () => {
    // A schema update that adds e.g. `enum`, `oneOf`, `"type": "integer"`, or
    // a `pattern` on a node without `"type": "string"` would otherwise be
    // silently ignored by validateAgainstSchema(). This is also the only check
    // on the JsonSchema annotation the JSON.parse above asserts.
    expect(unsupportedKeywords(agentPluginsSchema)).toEqual([]);
  });

  it('the keyword guard flags types and type-dependent keywords the validator would ignore', () => {
    expect(unsupportedKeywords(parseSchema('{"type":"integer"}'))).toEqual(['#/type: "integer"']);
    expect(unsupportedKeywords(parseSchema('{"type":["string","null"]}'))).toEqual([
      '#/type: ["string","null"]',
    ]);
    expect(unsupportedKeywords(parseSchema('{"required":["name"]}'))).toEqual([
      '#/required without type "object"',
    ]);
    expect(
      unsupportedKeywords(parseSchema('{"type":"object","properties":{"a":{"pattern":"x"}}}')),
    ).toEqual(['#/properties/a/pattern without type "string"']);
  });

  it('the keyword guard flags boolean subschemas the validator would treat as empty', () => {
    expect(unsupportedKeywords(parseSchema('{"type":"array","items":false}'))).toEqual([
      '#/items: non-object subschema false',
    ]);
    expect(unsupportedKeywords(parseSchema('{"type":"object","properties":{"x":false}}'))).toEqual([
      '#/properties/x: non-object subschema false',
    ]);
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

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'the local schema validator rejects a root key named after the Object.prototype member %s',
    (key) => {
      // Object.fromEntries makes even `__proto__` an own key, as JSON.parse
      // does when it reads a manifest file.
      const manifest = Object.fromEntries([...Object.entries(kiroPluginManifest), [key, 'x']]);
      expect(validateAgainstSchema(manifest, agentPluginsSchema)).toEqual([
        `$ has unknown key ${key}`,
      ]);
    },
  );

  it('the local schema validator rejects unknown keys inside author', () => {
    const author = Object.fromEntries([
      ['name', 'New Relic'],
      ['foo', 1],
      ['constructor', 'x'],
    ]);
    expect(validateAgainstSchema({ ...kiroPluginManifest, author }, agentPluginsSchema)).toEqual([
      '$.author has unknown key foo',
      '$.author has unknown key constructor',
    ]);
  });

  it('the local schema validator checks each extensions namespace against additionalProperties', () => {
    expect(
      validateAgainstSchema(
        { ...kiroPluginManifest, extensions: { 'dev.kiro': {} } },
        agentPluginsSchema,
      ),
    ).toEqual([]);
    expect(
      validateAgainstSchema(
        { ...kiroPluginManifest, extensions: { 'dev.kiro': 'x' } },
        agentPluginsSchema,
      ),
    ).toEqual(['$.extensions.dev.kiro must be an object']);
  });

  it('the local schema validator does not count an inherited member as a required key', () => {
    expect(
      validateAgainstSchema({}, parseSchema('{"type":"object","required":["toString"]}')),
    ).toEqual(['$ is missing required key toString']);
  });
});
