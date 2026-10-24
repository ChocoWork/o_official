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

module.exports = {
  ...base,
  // 分岐の網羅は単体の試験で測るので、tests/unit/ の下だけを流す
  testMatch: areas
    .flatMap((a) => a.tests)
    .filter((p) => p.startsWith('tests/unit/'))
    .map((p) => `<rootDir>/${p}`),
  collectCoverageFrom: areas.flatMap((a) => a.src),
  coverageThreshold: { global: { branches: 100 } },
};
