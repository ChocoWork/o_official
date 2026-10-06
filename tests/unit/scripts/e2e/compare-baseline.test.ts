/** @jest-environment node */
import {
  compareRuns,
  flattenPlaywrightJson,
  type PlaywrightJsonReport,
  type TestOutcome,
} from '@/../scripts/e2e/compare-baseline';

const row = (testId: string, outcome: TestOutcome['outcome'], title = `t-${testId}`): TestOutcome => ({
  testId, file: 'FR-X-001.spec.ts', title, project: 'chromium', outcome,
});

describe('flattenPlaywrightJson', () => {
  it('ファイルの下の describe を「 > 」でつなぎ、ファイル名は名前に含めない', () => {
    const report: PlaywrightJsonReport = {
      suites: [
        {
          title: 'FR-X-001.spec.ts',
          file: 'FR-X-001.spec.ts',
          specs: [{ id: 'a', title: 'top', file: 'FR-X-001.spec.ts', tests: [{ projectName: 'chromium', status: 'expected' }] }],
          suites: [
            {
              title: 'FR-X-001 画面',
              file: 'FR-X-001.spec.ts',
              specs: [{ id: 'b', title: 'mobile（390px）出る', file: 'FR-X-001.spec.ts', tests: [{ projectName: 'chromium', status: 'unexpected' }] }],
            },
          ],
        },
      ],
    };
    expect(flattenPlaywrightJson(report)).toEqual([
      { testId: 'a', file: 'FR-X-001.spec.ts', title: 'top', project: 'chromium', outcome: 'expected' },
      { testId: 'b', file: 'FR-X-001.spec.ts', title: 'FR-X-001 画面 > mobile（390px）出る', project: 'chromium', outcome: 'unexpected' },
    ]);
  });
});

describe('compareRuns', () => {
  it('前に通っていて後で落ちた・飛ばされたテストを挙げる', () => {
    const result = compareRuns(
      [row('a', 'expected'), row('b', 'expected'), row('c', 'expected')],
      [row('a', 'expected'), row('b', 'unexpected'), row('c', 'skipped')],
    );
    expect(result.regressions.map((t) => t.testId)).toEqual(['b', 'c']);
  });

  it('前に落ちていたテストは、後で落ちても挙げない。後で通れば「直った」に挙げる', () => {
    const result = compareRuns(
      [row('a', 'unexpected'), row('b', 'unexpected')],
      [row('a', 'unexpected'), row('b', 'expected')],
    );
    expect(result.regressions).toEqual([]);
    expect(result.fixed.map((t) => t.testId)).toEqual(['b']);
  });

  it('不安定（flaky）は通ったものとして扱う', () => {
    expect(compareRuns([row('a', 'flaky')], [row('a', 'flaky')]).regressions).toEqual([]);
  });

  it('番号が変わっても、ファイル・名前・プロジェクトが同じなら同じテストとして比べる', () => {
    const result = compareRuns([row('old-id', 'expected', 'same')], [row('new-id', 'unexpected', 'same')]);
    expect(result.regressions.map((t) => t.testId)).toEqual(['new-id']);
    expect(result.missing).toEqual([]);
  });

  it('前にだけある・後にだけあるテストを分けて挙げる', () => {
    const result = compareRuns([row('a', 'expected')], [row('b', 'expected')]);
    expect(result.missing.map((t) => t.testId)).toEqual(['a']);
    expect(result.added.map((t) => t.testId)).toEqual(['b']);
  });
});
