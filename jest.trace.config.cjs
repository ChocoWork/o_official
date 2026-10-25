// 範囲（scripts/trace/scope.json）の中だけで分岐の網羅を測る設定。
// 範囲は環境変数 TRACE_AREAS（カンマ区切り）で選ぶ。無ければ scope.json の全部。
// `npm run test:trace-coverage -- NEWS` の書き方は使えない（jest が NEWS を試験のパスの絞り込みとして読むため）。
const fs = require('node:fs');
const path = require('node:path');
const base = require('./jest.config.cjs');

const scope = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scripts/trace/scope.json'), 'utf8').replace(/^﻿/, ''),
);
const wanted = (process.env.TRACE_AREAS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const unknown = wanted.filter((name) => !scope.some((a) => a.area === name));
if (unknown.length > 0) {
  throw new Error(`TRACE_AREAS に scope.json に無い範囲がある: ${unknown.join(', ')}`);
}
const areas = wanted.length > 0 ? scope.filter((a) => wanted.includes(a.area)) : scope;

// 中括弧の型 `a/{b,c}/d` を `a/b/d`・`a/c/d` に開く。
// jest は testMatch を整える時に `/{` を `\{`（中括弧そのものの字）に変えるので、開かずに渡すと Windows で当たらない。
// scripts/trace は fs.globSync で中括弧を開いて読むので、開いて渡せば両方が同じファイルを選ぶ。
function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

module.exports = {
  ...base,
  // 分岐の網羅は単体の試験で測るので、結合（tests/integration/）以外を流す
  // （scripts/trace の levelOf も、e2e/ と tests/integration/ 以外は単体に数える。tests/features/ など）
  testMatch: areas
    .flatMap((a) => a.tests)
    .filter((p) => !p.startsWith('tests/integration/'))
    .flatMap(expandBraces)
    .map((p) => `<rootDir>/${p}`),
  collectCoverageFrom: areas.flatMap((a) => a.src),
  // 100% を求めない。届かない分岐は test-gaps.md の「届かない分岐」の節に理由つきで載せ、
  // scripts/trace/check-coverage.ts が「節に無い届かない分岐」と「節にあって今は届いている/無い分岐」で落とす。
};
