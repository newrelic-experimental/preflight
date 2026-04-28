import type { Config } from 'jest';
import baseConfig from '../../jest.config.base.ts';

const config: Config = {
  ...baseConfig,
  displayName: 'nr-ai-cicd',
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^@nr-ai-observatory/shared$': '<rootDir>/../shared/src/index.ts',
  },
};

export default config;
