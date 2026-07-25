import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

const EXTERNAL_SLUGS: Record<string, string> = {
  'docs/ADAPTERS.md': 'adapters',
  'docs/ADVANCED.md': 'advanced',
  'docs/ARCHITECTURE.md': 'architecture',
  'docs/COMMANDS_TABLE.md': 'commands-table',
  'docs/METRICS_TABLE.md': 'metrics-table',
  'docs/TEST_PATTERNS.md': 'test-patterns',
  'CONTRIBUTING.md': 'contributing',
};

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '..',
      pattern: ['site/src/content/docs/**/*.mdx', 'docs/*.md', 'CONTRIBUTING.md'],
      generateId: ({ entry }) =>
        EXTERNAL_SLUGS[entry] ??
        entry.replace(/^site\/src\/content\/docs\//, '').replace(/\.mdx?$/, ''),
    }),
    schema: docsSchema(),
  }),
};
