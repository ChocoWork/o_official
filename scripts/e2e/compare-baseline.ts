/**
 * E2E の切り替えの前後を比べる（設計書 2026-10-05 グループ B の 9-2）。
 *
 * 使い方: npm run e2e:compare -- [前の一覧] [後の Playwright JSON]
 * 既定の「前」: 2026-10-05 0:42 開始の全件（本番の DB）。既定の「後」: 最後の実行の test-results/e2e-results.json。
 * 前に通っていて後で通らないテストが1件でもあれば、終了コード1で終わる。
 */
import { readFileSync } from 'node:fs';

export type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';

export type TestOutcome = { testId: string; file: string; title: string; project: string; outcome: Outcome };

type JsonTest = { projectName: string; status: Outcome };
type JsonSpec = { id: string; title: string; file: string; tests: JsonTest[] };
type JsonSuite = { title: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] };

export type PlaywrightJsonReport = { suites: JsonSuite[] };

export type Comparison = {
  /** 前は通過、後は失敗・飛ばし */
  regressions: TestOutcome[];
  /** 前は失敗、後は通過 */
  fixed: TestOutcome[];
  /** 前にあり、後に無い */
  missing: TestOutcome[];
  /** 後にだけある */
  added: TestOutcome[];
};

const DEFAULT_BASELINE = '.superpowers/sdd/2026-10-05-webhook-queue-operations/e2e-baseline-2026-10-05-tests.json';
const DEFAULT_CURRENT = 'test-results/e2e-results.json';
const PASSED: ReadonlySet<Outcome> = new Set<Outcome>(['expected', 'flaky']);

const nameKey = (test: TestOutcome) => `${test.project}|${test.file}|${test.title}`;

export function flattenPlaywrightJson(report: PlaywrightJsonReport): TestOutcome[] {
  const rows: TestOutcome[] = [];
  const walk = (suite: JsonSuite, describePath: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        rows.push({
          testId: spec.id,
          file: spec.file,
          title: [...describePath, spec.title].join(' > '),
          project: test.projectName,
          outcome: test.status,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...describePath, child.title]);
  };
  // 一番外の suite はファイル。名前には含めない（前の一覧と同じ形）。
  for (const fileSuite of report.suites) walk(fileSuite, []);
  return rows;
}

export function compareRuns(baseline: TestOutcome[], current: TestOutcome[]): Comparison {
  const byId = new Map(current.map((test) => [test.testId, test]));
  const byName = new Map(current.map((test) => [nameKey(test), test]));
  const matched = new Set<TestOutcome>();
  const result: Comparison = { regressions: [], fixed: [], missing: [], added: [] };

  for (const before of baseline) {
    const after = byId.get(before.testId) ?? byName.get(nameKey(before));
    if (!after) {
      result.missing.push(before);
      continue;
    }
    matched.add(after);
    if (PASSED.has(before.outcome) && !PASSED.has(after.outcome)) result.regressions.push(after);
    if (before.outcome === 'unexpected' && PASSED.has(after.outcome)) result.fixed.push(after);
  }
  result.added = current.filter((test) => !matched.has(test));
  return result;
}

function main(argv: string[]): number {
  const baselinePath = argv[0] ?? DEFAULT_BASELINE;
  const currentPath = argv[1] ?? DEFAULT_CURRENT;
  const baseline = (JSON.parse(readFileSync(baselinePath, 'utf8')) as { tests: TestOutcome[] }).tests;
  const currentReport = JSON.parse(readFileSync(currentPath, 'utf8')) as PlaywrightJsonReport & { stats?: { startTime?: string } };
  const current = flattenPlaywrightJson(currentReport);
  console.log(`後の実行の開始: ${currentReport.stats?.startTime ?? '不明'}（${currentPath}）`);
  const result = compareRuns(baseline, current);

  console.log(`前: ${baseline.length}件 / 後: ${current.length}件`);
  console.log(`前に通っていて後で通らない: ${result.regressions.length}件`);
  for (const test of result.regressions) console.log(`  - [${test.outcome}] ${test.file} :: ${test.title}`);
  console.log(`前は失敗で後は通過: ${result.fixed.length}件`);
  console.log(`前にあり後に無い: ${result.missing.length}件`);
  for (const test of result.missing) console.log(`  - ${test.file} :: ${test.title}`);
  console.log(`後にだけある: ${result.added.length}件`);
  return result.regressions.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
