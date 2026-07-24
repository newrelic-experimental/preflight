import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://newrelic-experimental.github.io',
  base: '/preflight',
  integrations: [
    starlight({
      title: 'Preflight',
      description: 'Observability for AI coding assistants',
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ label: 'Getting Started', slug: 'getting-started' }],
        },
      ],
    }),
  ],
});
