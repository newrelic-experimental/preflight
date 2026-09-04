import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import { BASE } from './src/landing.ts';

export default defineConfig({
  site: 'https://newrelic-experimental.github.io',
  base: BASE,
  integrations: [
    starlight({
      title: 'Preflight',
      description: 'Observability for AI coding assistants',
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: "What's New", slug: 'whats-new' },
        {
          label: 'Getting Started',
          items: [{ label: 'Getting Started', slug: 'getting-started' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Platform Adapters', slug: 'adapters' },
            { label: 'Kiro Power', slug: 'kiro-power' },
            { label: 'MCP Commands Reference', slug: 'commands-table' },
            { label: 'Metrics Reference', slug: 'metrics-table' },
            { label: 'Advanced Configuration', slug: 'advanced' },
            { label: 'New Relic Scorecard Rules', slug: 'scorecards' },
            { label: 'Test Patterns', slug: 'test-patterns' },
            { label: 'Contributing', slug: 'contributing' },
          ],
        },
      ],
    }),
  ],
});
