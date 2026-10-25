// 範囲（scope.json）を読み、範囲内の文書・コード・テストから検査の材料を作る。

import fs from 'node:fs';
import path from 'node:path';
import { kindOf, type TraceItem } from './model';
import { parseCodeUnits } from './parse-code';
import { parseBadHeadings, parseDocItems } from './parse-docs';
import { parseTestRefs } from './parse-tests';
import type { TraceModel } from './rules';

export interface AreaScope { area: string; docs: string[]; src: string[]; tests: string[]; e2e: string[] }

// fs.globSync は Node 22 から在るが、手元の @types/node（20）には型が無い。
const globSync = (fs as unknown as { globSync(pattern: string, options: { cwd: string }): string[] }).globSync;
const ID_TOKEN = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g;
// 作業の記録と生成物は ID を定義せずに書く（例の SEC-999 など）ので、範囲外の定義に数えない。
const NOT_DEFINITIONS = ['docs/superpowers/', 'docs/05_Quality/reports/'];

export function loadScope(file = 'scripts/trace/scope.json'): AreaScope[] {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as AreaScope[];
}

/** パターンに合うファイルを、root からの `/` 区切りで、重なりを除いて返す（パターンごとに名前順）。 */
function collect(patterns: string[], root: string): string[] {
  const files = new Set<string>();
  for (const p of patterns) {
    for (const f of globSync(p, { cwd: root }).map((x) => x.replace(/\\/g, '/')).sort()) files.add(f);
  }
  return [...files];
}

/** 範囲内に定義のある「（範囲外）」の上位を parents に移す（印は「定義が範囲に無い」の意味だけにする）。 */
function adoptDefinedParents(items: TraceItem[]): TraceItem[] {
  const ids = new Set(items.map((i) => i.id));
  return items.map((i) => {
    const defined = i.outOfScopeParents.filter((p) => ids.has(p));
    if (defined.length === 0) return i;
    return { ...i, parents: [...i.parents, ...defined.filter((p) => !i.parents.includes(p))], outOfScopeParents: i.outOfScopeParents.filter((p) => !ids.has(p)) };
  });
}

/** ファイルに1つも当たらないパターン（打ち間違いを隠すので知らせる）。 */
export function unmatchedPatterns(areas: AreaScope[], root = process.cwd()): { area: string; pattern: string }[] {
  return areas.flatMap((a) =>
    [...a.docs, ...a.src, ...a.tests, ...a.e2e].filter((p) => collect([p], root).length === 0).map((pattern) => ({ area: a.area, pattern })),
  );
}

/**
 * areas を読む。referenceAreas を渡すと、そのうち areas に無い領域の文書の項目を referenceItems に入れる
 * （領域を絞った検査で、別の領域の ID を「範囲内に無い」にしないため。検査の対象にはならない）。
 */
export function loadModel(areas: AreaScope[], root = process.cwd(), referenceAreas: AreaScope[] = []): TraceModel {
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  const docs = collect(areas.flatMap((a) => a.docs), root);
  const src = collect(areas.flatMap((a) => a.src), root);
  const tests = collect(areas.flatMap((a) => [...a.tests, ...a.e2e]), root);

  const inScope = new Set(docs);
  const knownIdsOutsideScope = new Set<string>();
  for (const f of collect(['docs/**/*.md'], root)) {
    if (inScope.has(f) || f.split('/').includes('graphify-out') || NOT_DEFINITIONS.some((d) => f.startsWith(d))) continue;
    for (const m of read(f).matchAll(ID_TOKEN)) {
      if (kindOf(m[0]) !== null) knownIdsOutsideScope.add(m[0]);
    }
  }
  const referenceDocs = collect(referenceAreas.flatMap((a) => a.docs), root).filter((f) => !inScope.has(f));

  return {
    items: adoptDefinedParents(docs.flatMap((f) => parseDocItems(f, read(f)))),
    units: src.flatMap((f) => parseCodeUnits(f, read(f))),
    tests: tests.flatMap((f) => parseTestRefs(f, read(f))),
    knownIdsOutsideScope,
    badHeadings: docs.flatMap((f) => parseBadHeadings(f, read(f))),
    referenceItems: referenceDocs.flatMap((f) => parseDocItems(f, read(f))),
  };
}
