/** @jest-environment node */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compareRuns,
  flattenPlaywrightJson,
  main,
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
    expect(result).toMatchObject({ newFailures: [] });
  });

  it.each(['skipped', 'absent'] as const)('前が %s で後が失敗なら新しい失敗に挙げる', (before) => {
    const after = row('a', 'unexpected');
    const result = compareRuns(before === 'absent' ? [] : [row('a', before)], [after]);
    expect(result).toMatchObject({ regressions: [], newFailures: [after] });
  });

  it.each(['expected', 'flaky', 'skipped'] as const)('後が %s なら飛ばし・追加のテストも新しい失敗には挙げない', (outcome) => {
    const result = compareRuns([row('a', 'skipped')], [row('a', outcome), row('b', outcome)]);
    expect(result).toMatchObject({ newFailures: [] });
  });

  it('複数のプロジェクトが同じ testId を持っていても、番号とプロジェクトで照合する', () => {
    const firefoxBefore = { ...row('a', 'skipped'), project: 'firefox' };
    const chromiumAfter = row('a', 'unexpected', 'renamed-chromium');
    const firefoxAfter = { ...row('a', 'expected', 'renamed-firefox'), project: 'firefox' };
    expect(compareRuns([row('a', 'expected'), firefoxBefore], [chromiumAfter, firefoxAfter])).toMatchObject({
      regressions: [chromiumAfter], newFailures: [], missing: [], added: [],
    });
  });

  it('同じ番号でも別のプロジェクトなら同じテストとして扱わない', () => {
    const after = { ...row('a', 'unexpected'), project: 'firefox' };
    expect(compareRuns([row('a', 'expected')], [after])).toMatchObject({
      regressions: [], newFailures: [after], missing: [row('a', 'expected')], added: [after],
    });
  });

  it('番号と名前の両方が一致候補にあるときは番号とプロジェクトを優先する', () => {
    const byId = row('a', 'unexpected', 'renamed');
    const byName = row('b', 'expected', 'same');
    expect(compareRuns([row('a', 'expected', 'same')], [byId, byName])).toMatchObject({
      regressions: [byId], newFailures: [], added: [byName],
    });
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

describe('main', () => {
  let tempDir: string;
  let log: jest.SpyInstance;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-compare-'));
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const run = (baseline: TestOutcome[], current: TestOutcome[], errors?: unknown[]) => {
    const beforePath = path.join(tempDir, 'before.json');
    const afterPath = path.join(tempDir, 'after.json');
    fs.writeFileSync(beforePath, JSON.stringify({ tests: baseline }));
    fs.writeFileSync(afterPath, JSON.stringify({
      stats: { startTime: '2026-10-07T00:00:00.000Z' },
      ...(errors === undefined ? {} : { errors }),
      suites: [{
        title: 'files',
        specs: current.map((test) => ({
          id: test.testId, file: test.file, title: test.title,
          tests: [{ projectName: test.project, status: test.outcome }],
        })),
      }],
    }));
    return { code: main([beforePath, afterPath]), afterPath, lines: log.mock.calls.map(([line]) => line) };
  };

  it.each(['skipped', 'absent'] as const)('前が %s の新しい失敗で終了コード1を返す', (before) => {
    const result = run(before === 'absent' ? [] : [row('a', before)], [row('a', 'unexpected')]);
    expect(result.code).toBe(1);
    expect(result.lines).toContain('前は飛ばし・前に無くて、後で失敗: 1件');
    expect(result.lines).toContain('  - [unexpected] FR-X-001.spec.ts :: t-a');
  });

  it('後退も新しい失敗も無いときは終了コード0を返す', () => {
    expect(run([row('a', 'unexpected')], [row('a', 'unexpected'), row('b', 'flaky')]).code).toBe(0);
  });

  it('前に通っていて後で通らないときは終了コード1を保つ', () => {
    expect(run([row('a', 'expected')], [row('a', 'skipped')]).code).toBe(1);
  });

  it('指定の順序で出し、後に無い分はファイル順に1行ずつの件数でまとめる', () => {
    const baseline = [
      row('r', 'expected'), row('n', 'skipped'), row('f', 'unexpected'),
      { ...row('m1', 'expected'), file: 'z.spec.ts' },
      { ...row('m2', 'expected'), file: 'a.spec.ts' },
      { ...row('m3', 'expected'), file: 'z.spec.ts' },
    ];
    const result = run(baseline, [row('r', 'unexpected'), row('n', 'unexpected'), row('f', 'expected'), row('added', 'expected')]);
    expect(result.lines).toEqual([
      `後の実行の開始: 2026-10-07T00:00:00.000Z（${result.afterPath}）`,
      '前: 6件 / 後: 4件',
      '前に通っていて後で通らない: 1件',
      '  - [unexpected] FR-X-001.spec.ts :: t-r',
      '前は飛ばし・前に無くて、後で失敗: 1件',
      '  - [unexpected] FR-X-001.spec.ts :: t-n',
      '前は失敗で後は通過: 1件',
      '前にあり後に無い: 3件',
      '  - a.spec.ts: 1件',
      '  - z.spec.ts: 2件',
      '後にだけある: 1件',
    ]);
  });

  it.each([
    { current: [], errors: undefined, count: 0 },
    { current: [], errors: [{ message: '起動失敗' }], count: 1 },
    { current: [row('a', 'expected')], errors: [{ message: 'エラー1' }, { message: 'エラー2' }], count: 2 },
  ])('空の実行か起動失敗は開始行の直後に警告し、それだけでは失敗にしない（errors: $count）', ({ current, errors, count }) => {
    const result = run([], current, errors);
    expect(result.code).toBe(0);
    expect(result.lines[1]).toBe(`注意: 後の実行でテストが1件も流れていないか、起動に失敗しています（errors: ${count}件）。`);
    expect(result.lines[2]).toBe(`前: 0件 / 後: ${current.length}件`);
  });

  it('テストがありトップレベルの errors が空なら警告しない', () => {
    expect(run([], [row('a', 'expected')], []).lines[1]).toBe('前: 0件 / 後: 1件');
  });
});
