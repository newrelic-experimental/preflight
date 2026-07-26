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
      // Named explicitly, not a 'docs/*.md' wildcard — the internal repo this
      // content mirrors from also holds internal-only files (PRODUCT_BRIEF.md,
      // ROADMAP.md, etc.) that must never be built into site pages, even unlinked.
      pattern: [
        'site/src/content/docs/**/*.mdx',
        'docs/ADAPTERS.md',
        'docs/ADVANCED.md',
        'docs/ARCHITECTURE.md',
        'docs/COMMANDS_TABLE.md',
        'docs/METRICS_TABLE.md',
        'docs/TEST_PATTERNS.md',
        'CONTRIBUTING.md',
      ],
      generateId: ({ entry }) =>
        EXTERNAL_SLUGS[entry] ??
        entry.replace(/^site\/src\/content\/docs\//, '').replace(/\.mdx?$/, ''),
    }),
    schema: docsSchema(),
  }),
};
