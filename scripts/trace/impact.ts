// npm run trace -- <ID かファイルの場所>
// 1つの ID（またはファイル）から、上（要求まで）と下（テストまで）と、同じ DD を共有する単位を出す。
// 設計: docs/superpowers/specs/2026-10-24-traceability-design.md の 7。

import { loadModel, loadScope } from './load';
import type { TraceItem, TraceKind } from './model';
import type { CodeUnit } from './parse-code';
import type { TestRef } from './parse-tests';
import type { TraceModel } from './rules';

export interface Impact { upstream: TraceItem[]; downstream: TraceItem[]; units: CodeUnit[]; tests: TestRef[]; siblings: CodeUnit[] }

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** 項目の上位を、範囲内に定義のある物だけ近い順にたどる。 */
export function ancestorsOf(model: TraceModel, startIds: string[]): TraceItem[] {
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: TraceItem[] = [];
  let frontier = startIds;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const it = byId.get(id);
      if (!it || seen.has(id)) continue;
      seen.add(id);
      out.push(it);
      next.push(...it.parents);
    }
    frontier = next;
  }
  return out;
}

function descendantsOf(model: TraceModel, startIds: string[]): TraceItem[] {
  const seen = new Set(startIds);
  const out: TraceItem[] = [];
  let frontier = startIds;
  while (frontier.length > 0) {
    const kids = model.items.filter((c) => !seen.has(c.id) && c.parents.some((p) => frontier.includes(p)));
    for (const k of kids) seen.add(k.id);
    out.push(...kids);
    frontier = kids.map((k) => k.id);
  }
  return out;
}

/** target に当たる項目と単位（項目の ID・単位の IMPL ID・文書かコードのファイルの場所）。 */
export function startOf(model: TraceModel, target: string): { items: TraceItem[]; units: CodeUnit[] } {
  const where = normalize(target);
  return {
    items: model.items.filter((i) => i.id === target || normalize(i.file) === where),
    units: model.units.filter((u) => u.implId === target || normalize(u.file) === where),
  };
}

/** 要件の段の種類。上にあれば、その受け入れ条件の E2E も影響を受けるとみなす。 */
const REQUIREMENT_LEVEL: readonly TraceKind[] = ['REQ', 'SEC', 'DRV'];

/**
 * target は startOf と同じ。
 * テストは、たどった項目と、上の要件・セキュリティ要件・派生要件の受け入れ条件を指す物（要件の振る舞いを確かめるため）。
 */
export function impactOf(model: TraceModel, target: string): Impact {
  const { items: startItems, units: startUnits } = startOf(model, target);
  const startIds = startItems.map((i) => i.id);

  const upstream = ancestorsOf(model, [...startItems.flatMap((i) => i.parents), ...startUnits.flatMap((u) => u.designIds)])
    .filter((i) => !startIds.includes(i.id));
  const downstream = descendantsOf(model, startIds);

  const below = new Set([...startIds, ...downstream.map((i) => i.id)]);
  const units = [...startUnits, ...model.units.filter((u) => !startUnits.includes(u) && u.designIds.some((d) => below.has(d)))];
  const sharedDesigns = new Set(startUnits.flatMap((u) => u.designIds));
  const siblings = model.units.filter((u) => !units.includes(u) && u.designIds.some((d) => sharedDesigns.has(d)));

  const chain = new Set([...below, ...upstream.map((i) => i.id)]);
  const upperReqs = new Set(upstream.filter((i) => REQUIREMENT_LEVEL.includes(i.kind)).map((i) => i.id));
  for (const ac of model.items) {
    if (ac.kind === 'AC' && ac.parents.some((p) => upperReqs.has(p))) chain.add(ac.id);
  }
  const tests = model.tests.filter((t) => t.id !== null && chain.has(t.id));
  return { upstream, downstream, units, tests, siblings };
}

const itemLine = (i: TraceItem) => `  ${i.id} ${i.title}（${i.file}:${i.line}）`;
const unitLine = (u: CodeUnit) => `  ${u.implId ?? '（@impl なし）'} ${u.file}:${u.line} の ${u.symbol}（@design ${u.designIds.join('、') || 'なし'}）`;

function print(title: string, lines: string[]): void {
  console.log(`${title}: ${lines.length}件`);
  for (const l of lines) console.log(l);
}

function main(argv: string[]): number {
  const target = argv[0];
  if (argv.length !== 1 || !target) {
    console.error('使い方: npm run trace -- <ID かファイルの場所>');
    return 2;
  }
  const model = loadModel(loadScope());
  const start = startOf(model, target);
  if (start.items.length + start.units.length === 0) {
    console.error(`${target} は scope.json の範囲の文書・コードに見つからない`);
    return 1;
  }
  const r = impactOf(model, target);
  console.log(`対象: ${target}`);
  print('対象の項目', start.items.map(itemLine));
  print('上（要求まで）', r.upstream.map(itemLine));
  print('下', r.downstream.map(itemLine));
  print('コードの単位', r.units.map(unitLine));
  print('同じ DD を共有する単位', r.siblings.map(unitLine));
  print('テスト', r.tests.map((t) => `  [${t.level}] ${t.file}:${t.line} ${t.title}`));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
