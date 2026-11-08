/* eslint-disable @typescript-eslint/no-require-imports -- Jest の CommonJS 設定。 */
const base = require('./jest.config.cjs');
const { timingTestPattern, timingTestMatch } = require('./scripts/test/jest-timing.cjs');

module.exports = {
  ...base,
  testMatch: timingTestMatch,
  testPathIgnorePatterns: base.testPathIgnorePatterns.filter((pattern) => pattern !== timingTestPattern),
};
