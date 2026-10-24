/** @jest-environment node */
const ORIGINAL = process.env.TRACE_AREAS;

function loadConfig(areas: string | undefined) {
  if (areas === undefined) delete process.env.TRACE_AREAS;
  else process.env.TRACE_AREAS = areas;
  let cfg: any;
  jest.isolateModules(() => {
    cfg = require('@/../jest.trace.config.cjs');
  });
  return cfg;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TRACE_AREAS;
  else process.env.TRACE_AREAS = ORIGINAL;
});

it('NEWS の範囲だけを集め、分岐 100% を求める', () => {
  const cfg = loadConfig('NEWS');
  expect(cfg.collectCoverageFrom).toContain('src/features/news/**/*.{ts,tsx}');
  expect(cfg.coverageThreshold).toEqual({ global: { branches: 100 } });
  expect(cfg.moduleNameMapper['^@/(.*)$']).toBe('<rootDir>/src/$1');
});

it('testMatch は範囲の tests のうち tests/unit/ の下だけにする', () => {
  const cfg = loadConfig('NEWS');
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/**/*news*.test.{ts,tsx}');
  expect(cfg.testMatch.every((p: string) => p.startsWith('<rootDir>/tests/unit/'))).toBe(true);
});

it('ほかの設定は jest.config.cjs をそのまま引き継ぐ', () => {
  const cfg = loadConfig('NEWS');
  const base = require('@/../jest.config.cjs');
  expect(cfg.preset).toBe(base.preset);
  expect(cfg.testEnvironment).toBe(base.testEnvironment);
  expect(cfg.setupFilesAfterEnv).toEqual(base.setupFilesAfterEnv);
});

it('TRACE_AREAS が無ければ scope.json の全部の範囲を使う', () => {
  const cfg = loadConfig(undefined);
  expect(cfg.collectCoverageFrom).toContain('src/features/news/**/*.{ts,tsx}');
});

it('scope.json に無い範囲の名前は止める', () => {
  expect(() => loadConfig('NOPE')).toThrow(/NOPE/);
});
