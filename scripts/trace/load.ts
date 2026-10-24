// 範囲（scope.json）を読み、範囲内の文書・コード・テストから検査の材料を作る。

import fs from 'node:fs';
import path from 'node:path';
import { kindOf } from './model';
import { parseCodeUnits } from './parse-code';
import { parseDocItems } from './parse-docs';
import { parseTestRefs } from './parse-tests';
import type { TraceModel } from './rules';

export interface AreaScope { area: string; docs: string[]; src: string[]; tests: string[]; e2e: string[] }

// fs.globSync は Node 22 から在るが、手元の @types/node（20）には型が無い。
const globSync = (fs as unknown as { globSync(pattern: string, options: { cwd: string }): string[] }).globSync;
const ID_TOKEN = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;

export function loadScope(file = 'scripts/trace/scope.json'): AreaScope[] {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as AreaScope[];
}

/** パターンに合うファイルを、root からの `/` 区切りで、重なりを除いて返す（パターンごとに名前順）。 */
function collect(patterns: string[], root: string): string[] {
  const files = new Set<string>();
  for (const p of patterns) {
    for (const f of globSync(p, { cwd: root }).map((x) => x.replace(/\\/g, '/')).sort()) files.add(f);
  }
  return [...files];
}

export function loadModel(areas: AreaScope[], root = process.cwd()): TraceModel {
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  const docs = collect(areas.flatMap((a) => a.docs), root);
  const src = collect(areas.flatMap((a) => a.src), root);
  const tests = collect(areas.flatMap((a) => [...a.tests, ...a.e2e]), root);

  const inScope = new Set(docs);
  const knownIdsOutsideScope = new Set<string>();
  for (const f of collect(['docs/**/*.md'], root)) {
    if (inScope.has(f) || f.split('/').includes('graphify-out')) continue;
    for (const m of read(f).matchAll(ID_TOKEN)) {
      if (kindOf(m[0]) !== null) knownIdsOutsideScope.add(m[0]);
    }
  }

  return {
    items: docs.flatMap((f) => parseDocItems(f, read(f))),
    units: src.flatMap((f) => parseCodeUnits(f, read(f))),
    tests: tests.flatMap((f) => parseTestRefs(f, read(f))),
    knownIdsOutsideScope,
  };
}
