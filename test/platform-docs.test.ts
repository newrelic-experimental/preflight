import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDefaultRegistry } from '../src/platforms/platform-registry.js';

const repoRoot = resolve(__dirname, '..');

const adaptersContent = readFileSync(resolve(repoRoot, 'docs/ADAPTERS.md'), 'utf-8');
const readmeContent = readFileSync(resolve(repoRoot, 'README.md'), 'utf-8');
const landingContent = readFileSync(resolve(repoRoot, 'site/src/landing.ts'), 'utf-8');

interface PlatformSection {
  readonly displayName: string;
  readonly platformName: string;
}

function parsePlatformSections(): PlatformSection[] {
  return Array.from(adaptersContent.matchAll(/^## (.+?)\s*\(`([^`]+)`\)$/gm), (m) => ({
    displayName: m[1],
    platformName: m[2],
  }));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-');
}

describe('Platform documentation consistency', () => {
  const platformSections = parsePlatformSections();
  const registry = createDefaultRegistry();
  const registeredAdapters = registry.getRegistered();

  it('every registered adapter has a section in ADAPTERS.md', () => {
    const registeredNames = new Set(registeredAdapters.map((a) => a.platformName));
    const docNames = new Set(platformSections.map((s) => s.platformName));

    expect(registeredNames).toEqual(docNames);
  });

  it('README Works With section lists all named platforms', () => {
    const namedPlatforms = platformSections.filter((s) => s.platformName !== 'generic-mcp');

    const worksWithSection =
      readmeContent.match(/## Works With\n\n(.+?)\n\n(?:---|\n##)/s)?.[1] || '';

    const displayNames = namedPlatforms.map((s) => s.displayName);

    for (const displayName of displayNames) {
      expect(worksWithSection).toContain(displayName);
    }
  });

  it('every anchor in landing.ts matches a platform and all platforms are represented', () => {
    const anchors = new Set(
      Array.from(landingContent.matchAll(/anchor:\s*'([^']+)'/g), (m) => m[1]),
    );

    const expectedAnchors = new Set(
      platformSections.map((s) => slug(`${s.displayName} ${s.platformName}`)),
    );

    expect(anchors).toEqual(expectedAnchors);
  });
});
