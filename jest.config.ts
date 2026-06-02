import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/test/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        useESM: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  // commander v15 is pure ESM (no CJS entry); jest's default transformIgnorePatterns
  // skips node_modules, which leaves its `import` statements as syntax errors when
  // CJS test bundles try to require it. Allow commander through the transformer
  // (the transform regex above also matches .js so ts-jest will rewrite it).
  transformIgnorePatterns: ['/node_modules/(?!commander/)'],
  testTimeout: 15_000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/index.ts'],
  coverageReporters: ['text', 'lcov'],
  coverageDirectory: 'coverage',
  displayName: 'nr-ai-mcp-server',
  maxWorkers: 1,
  forceExit: true,
};

export default config;
