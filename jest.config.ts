import type { Config } from 'jest';

const config: Config = {
  projects: ['packages/shared', 'packages/nr-ai-mcp-server'],
  maxWorkers: 1,
  forceExit: true,
};

export default config;
