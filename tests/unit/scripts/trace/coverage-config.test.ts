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
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/**/*news*.test.ts');
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/**/*news*.test.tsx');
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

it('testMatch は中括弧を開いて渡す（jest が `/{` を中括弧そのものの字に変えて Windows で当たらなくなるのを避ける）', () => {
  const cfg = loadConfig('AUTH');
  expect(cfg.testMatch.some((p: string) => /[{}]/.test(p))).toBe(false);
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/components/LoginModal.test.tsx');
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/components/Header.test.tsx');
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/**/format-countdown*.test.ts');
  expect(cfg.testMatch).toContain('<rootDir>/tests/unit/**/use-turnstile-widget*.test.tsx');
});

it('開いた testMatch が選ぶファイルは、scripts/trace が scope.json の tests から選ぶ tests/unit/ のファイルと同じ', () => {
  const fs = require('node:fs');
  const scope = JSON.parse(fs.readFileSync('scripts/trace/scope.json', 'utf8').replace(/^﻿/, ''));
  const glob = (p: string): string[] => fs.globSync(p, { cwd: process.cwd() }).map((f: string) => f.replaceAll(String.fromCharCode(92), '/'));
  for (const a of scope) {
    const cfg = loadConfig(a.area);
    const expected = new Set<string>(
      a.tests.filter((p: string) => p.startsWith('tests/unit/')).flatMap(glob),
    );
    const actual = new Set<string>(cfg.testMatch.flatMap((p: string) => glob(p.replace('<rootDir>/', ''))));
    expect([...actual].sort()).toEqual([...expected].sort());
  }
});
