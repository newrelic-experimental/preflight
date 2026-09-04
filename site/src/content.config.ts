import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

const EXTERNAL_SLUGS: Record<string, string> = {
  'docs/WHATS_NEW.md': 'whats-new',
  'docs/ADAPTERS.md': 'adapters',
  'docs/ADVANCED.md': 'advanced',
  'docs/ARCHITECTURE.md': 'architecture',
  'docs/COMMANDS_TABLE.md': 'commands-table',
  'docs/METRICS_TABLE.md': 'metrics-table',
  'docs/TEST_PATTERNS.md': 'test-patterns',
  'docs/KIRO_POWER.md': 'kiro-power',
  'docs/SCORECARDS.md': 'scorecards',
  'CONTRIBUTING.md': 'contributing',
};

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '..',
      // Named explicitly, not a 'docs/*.md' wildcard, so a non-public file ever
      // added to docs/ is never accidentally built into a site page, even unlinked.
      pattern: [
        'site/src/content/docs/**/*.mdx',
        'docs/WHATS_NEW.md',
        'docs/ADAPTERS.md',
        'docs/ADVANCED.md',
        'docs/ARCHITECTURE.md',
        'docs/COMMANDS_TABLE.md',
        'docs/METRICS_TABLE.md',
        'docs/TEST_PATTERNS.md',
        'docs/KIRO_POWER.md',
        'docs/SCORECARDS.md',
        'CONTRIBUTING.md',
      ],
      generateId: ({ entry }) =>
        EXTERNAL_SLUGS[entry] ??
        entry.replace(/^site\/src\/content\/docs\//, '').replace(/\.mdx?$/, ''),
    }),
    schema: docsSchema(),
  }),
};
