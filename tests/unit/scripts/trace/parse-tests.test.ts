/** @jest-environment node */
import { levelOf, parseTestRefs } from '@/../scripts/trace/parse-tests';

describe('parseTestRefs', () => {
  it('テスト名の先頭の ID を読み、describe の ID は数えない', () => {
    const src = "test.describe('FR-NEWS-ALL-001 一覧', () => {\n  test(`FR-NEWS-ALL-001-AC-01 新しい順 ${vp.name}`, async () => {});\n  test('名前に ID が無い', async () => {});\n});\n";
    expect(parseTestRefs('e2e/FR-NEWS-ALL-001-x.spec.ts', src)).toEqual([
      { id: 'FR-NEWS-ALL-001-AC-01', level: 'e2e', file: 'e2e/FR-NEWS-ALL-001-x.spec.ts', line: 2, title: 'FR-NEWS-ALL-001-AC-01 新しい順 ${vp.name}', skipped: false },
      { id: null, level: 'e2e', file: 'e2e/FR-NEWS-ALL-001-x.spec.ts', line: 3, title: '名前に ID が無い', skipped: false },
    ]);
  });

  it('it・only・skip・each を読み、ほかの test.* と ID でない語は数えない', () => {
    const src = [
      "describe('DD-NEWS-001 x', () => {",
      "  it('DD-NEWS-003: 下書きを返さない', () => {});",
      "  test.only('DD-NEWS-004 a', () => {});",
      "  it.skip('NEWS 形だけ', () => {});",
      "  it.each([[1], [2]])('DD-NEWS-005 %s', () => {});",
      "  test.beforeEach(async () => {});",
      "  test.step('DD-NEWS-009 段', async () => {});",
      "  test.skip(true, 'DD-NEWS-010 理由');",
      "  describe.each([[1]])('DD-NEWS-011 %s', () => {});",
      '});',
      '',
    ].join('\n');
    expect(parseTestRefs('tests/unit/features/news/public.test.ts', src).map((r) => [r.id, r.line, r.level])).toEqual([
      ['DD-NEWS-003', 2, 'unit'],
      ['DD-NEWS-004', 3, 'unit'],
      [null, 4, 'unit'],
      ['DD-NEWS-005', 5, 'unit'],
    ]);
  });

  it('skip・todo・fixme は skipped にし、only・each・普通の試験は skipped にしない', () => {
    const src = [
      "test.skip('FR-NEWS-ALL-001-AC-01 中身が無い');",
      "it.todo('DD-NEWS-020 あとで');",
      "test.fixme('FR-NEWS-ALL-001-AC-02 直す', async () => {});",
      "test.only('FR-NEWS-ALL-001-AC-03 これだけ', async () => {});",
      "it.each([[1]])('DD-NEWS-021 %s', () => {});",
      "it('DD-NEWS-022 ふつう', () => {});",
      "test.skip(!process.env.KEY, 'FR-NEWS-ALL-001-AC-04 条件つきの飛ばし');",
    ].join('\n');
    expect(parseTestRefs('e2e/a.spec.ts', src).map((r) => [r.id, r.skipped])).toEqual([
      ['FR-NEWS-ALL-001-AC-01', true],
      ['DD-NEWS-020', true],
      ['FR-NEWS-ALL-001-AC-02', true],
      ['FR-NEWS-ALL-001-AC-03', false],
      ['DD-NEWS-021', false],
      ['DD-NEWS-022', false],
    ]);
  });

  it('.tsx のテストも読む', () => {
    const src = "it('DD-NEWS-006 出す', () => { render(<A />); });\n";
    expect(parseTestRefs('tests/integration/ui/news.test.tsx', src)).toEqual([
      { id: 'DD-NEWS-006', level: 'integration', file: 'tests/integration/ui/news.test.tsx', line: 1, title: 'DD-NEWS-006 出す', skipped: false },
    ]);
  });
});

describe('levelOf', () => {
  it('levelOf は置き場で段を決める', () => {
    expect(levelOf('e2e/a.spec.ts')).toBe('e2e');
    expect(levelOf('tests/integration/ui/news.test.tsx')).toBe('integration');
    expect(levelOf('tests/unit/features/news/public.test.ts')).toBe('unit');
  });

  it('Windows の区切りでも段を決める', () => {
    expect(levelOf('e2e\\a.spec.ts')).toBe('e2e');
    expect(levelOf('tests\\integration\\db\\x.test.ts')).toBe('integration');
  });

  it('e2e/ で始まる置き場だけを e2e にする', () => {
    expect(levelOf('tests/unit/scripts/e2e/x.test.ts')).toBe('unit');
  });
});
