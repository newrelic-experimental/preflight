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
  displayName: 'preflight',
  maxWorkers: 1,
  forceExit: true,
  // src/shared/index.test.ts verifies that VERSION matches the upstream package.json.
  // That invariant is not meaningful here — shared is inlined source, not a versioned
  // package — and the path resolution (join(__dirname, '..', 'package.json')) resolves
  // correctly in the upstream repo but to src/package.json (non-existent) in this layout.
  // Integration tests spawn real child processes and require a compiled binary
  // (built via beforeAll). They run via `npm run test:integration` only.
  testPathIgnorePatterns: [
    '/node_modules/',
    'src/shared/index\\.test\\.ts',
    '<rootDir>/src/multi-instance\\.integration\\.test\\.ts',
  ],
};

export default config;
