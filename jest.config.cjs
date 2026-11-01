module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    // css must be matched before the '@/' alias, otherwise '@/...css' imports
    // resolve to real CSS files (which ts-jest can't transform) instead of the stub.
    '\\.(css)$': '<rootDir>/tests/styleMock.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testMatch: ['**/tests/**/*.test.(ts|tsx|js)'],
  // .claude/worktrees に置かれる別の作業ツリーの写しを、この作業ツリーの試験として拾わない
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
  setupFiles: ['<rootDir>/tests/setupRequestPolyfill.js', '<rootDir>/tests/setupClientIp.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setupTests.ts'],
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.jest.json',
    },
  },
};
