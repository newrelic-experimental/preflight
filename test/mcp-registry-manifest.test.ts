import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

const packageJson: { version: string; mcpName: string } = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
);

const serverJson: {
  name: string;
  version: string;
  packages: Array<{ registryType: string; identifier: string; version: string }>;
} = JSON.parse(readFileSync(resolve(repoRoot, 'server.json'), 'utf-8'));

describe('MCP Registry manifest', () => {
  it('name matches package.json mcpName', () => {
    expect(serverJson.name).toBe(packageJson.mcpName);
  });

  it('version stays in sync with package.json', () => {
    // release.yml overwrites this at publish time from package.json, but
    // that rewrite never gets committed back — this test exists so the
    // committed value doesn't silently drift between releases.
    expect(serverJson.version).toBe(packageJson.version);
  });

  it('the npm package entry version stays in sync with package.json', () => {
    const npmPackage = serverJson.packages.find((p) => p.registryType === 'npm');
    expect(npmPackage?.identifier).toBe('@newrelic/preflight');
    expect(npmPackage?.version).toBe(packageJson.version);
  });
});
