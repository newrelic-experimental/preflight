import type { Config } from 'jest';

const config: Config = {
  projects: ['packages/shared', 'packages/nr-ai-agent', 'packages/nr-ai-mcp-server', 'packages/nr-ai-cicd'],
  maxWorkers: 1,
  forceExit: true,
};

export default config;
