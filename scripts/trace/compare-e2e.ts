// npm run trace:compare-e2e -- <前の Playwright JSON> <後の Playwright JSON>
// テスト名の頭に ID を付ける前後の E2E を、名前の対応表（renameMap）で突き合わせて比べる（設計 9-2）。
// 前に通っていて後で通らない物・新しい失敗が1件でもあれば終了コード 1。

import { readFileSync } from 'node:fs';
import { compareRuns, flattenPlaywrightJson, type PlaywrightJsonReport, type TestOutcome } from '../e2e/compare-baseline';
import { kindOf } from './model';
import type { TestRef } from './parse-tests';

const LEAD = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s+/;

/** 頭の ID（とその後の空白）を除く。flatten の名前は describe を ` > ` でつなぐので、段ごとに除く。 */
function withoutIds(title: string): string {
  return title
    .split(' > ')
    .map((part) => {
      const m = LEAD.exec(part);
      return m && kindOf(m[1]) !== null ? part.slice(m[0].length) : part;
    })
    .join(' > ');
}

const keyOf = (r: { file: string; title: string }) => `${r.file}::${r.title}`;

/**
 * 「ファイル::前の名前」→ 後の名前。同じファイルで、頭の ID を除くと同じ名前になり、名前が変わった物だけを載せる。
 * 当てはまる後の名前が2つ以上あれば、行の近い物に当てる。1つの後の名前は1回だけ使う。
 */
export function renameMap(before: TestRef[], after: TestRef[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<TestRef>();
  for (const b of before) {
    const base = withoutIds(b.title);
    const candidates = after.filter((a) => !used.has(a) && a.file === b.file && withoutIds(a.title) === base);
    if (candidates.some((a) => a.title === b.title)) continue;
    const best = candidates.sort((x, y) => Math.abs(x.line - b.line) - Math.abs(y.line - b.line))[0];
    if (!best || map.has(keyOf(b))) continue;
    used.add(best);
    map.set(keyOf(b), best.title);
  }
  return map;
}

type RawSpec = { id: string; line?: number };
type RawSuite = { specs?: RawSpec[]; suites?: RawSuite[] };

/** 結果を、ファイルと名前ごとに1つのテストの参照にする（幅ごとの重なりを除く）。行は JSON の spec の行。 */
function refsOf(report: PlaywrightJsonReport, rows: TestOutcome[]): TestRef[] {
  const lines = new Map<string, number>();
  const walk = (s: RawSuite) => {
    for (const spec of s.specs ?? []) lines.set(spec.id, spec.line ?? 0);
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of report.suites as RawSuite[]) walk(s);
  const refs = new Map<string, TestRef>();
  for (const r of rows) {
    if (!refs.has(keyOf(r))) refs.set(keyOf(r), { id: null, level: 'e2e', file: r.file, line: lines.get(r.testId) ?? 0, title: r.title });
  }
  return [...refs.values()];
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as PlaywrightJsonReport;

export function main(argv: string[]): number {
  if (argv.length !== 2) {
    console.error('使い方: npm run trace:compare-e2e -- <前の Playwright JSON> <後の Playwright JSON>');
    return 2;
  }
  const [beforeReport, afterReport] = argv.map(read);
  const before = flattenPlaywrightJson(beforeReport);
  const after = flattenPlaywrightJson(afterReport);
  const renames = renameMap(refsOf(beforeReport, before), refsOf(afterReport, after));
  const renamed = before.map((t) => ({ ...t, title: renames.get(keyOf(t)) ?? t.title }));
  const result = compareRuns(renamed, after);

  const list = (label: string, rows: TestOutcome[]) => {
    console.log(`${label}: ${rows.length}件`);
    for (const t of rows) console.log(`  - [${t.project}] [${t.outcome}] ${t.file} :: ${t.title}`);
  };
  console.log(`前: ${before.length}件 / 後: ${after.length}件 / 名前を変えた: ${renames.size}件`);
  for (const [from, to] of renames) console.log(`  - ${from} → ${to}`);
  list('前に通っていて後で通らない', result.regressions);
  list('前は飛ばし・前に無くて、後で失敗', result.newFailures);
  list('前は失敗で後は通過', result.fixed);
  list('前にあり後に無い', result.missing);
  list('後にだけある', result.added);
  if (result.missing.length > 0) {
    console.error(`注意: 前にあり後に無いテストが ${result.missing.length} 件ある（名前の対応が付かなかったか、後で流していない）。終了コードには数えない`);
  }
  return result.regressions.length + result.newFailures.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
