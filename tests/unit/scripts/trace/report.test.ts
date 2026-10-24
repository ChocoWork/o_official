/** @jest-environment node */
import type { TraceItem } from '@/../scripts/trace/model';
import type { CodeUnit } from '@/../scripts/trace/parse-code';
import type { TestRef } from '@/../scripts/trace/parse-tests';
import { keepHandSection, parseUncovered, renderMatrix, renderTestGaps } from '@/../scripts/trace/report';
import type { TraceModel } from '@/../scripts/trace/rules';

const item = (id: string, kind: TraceItem['kind'], parents: string[], o: Partial<TraceItem> = {}): TraceItem => ({
  id, kind, title: `${id}の題`, file: 'docs/a.md', line: 1, parents, outOfScopeParents: [], rationale: 'r', status: '現行', oldIds: [], ...o,
});
const unit = (implId: string | undefined, file: string, symbol: string, designIds: string[]): CodeUnit => ({
  file, line: 7, symbol, unitKind: 'function', implId, designIds, remarks: '',
});
const test = (id: string | null, level: TestRef['level'], file: string, line = 3): TestRef => ({ id, level, file, line, title: `${id ?? ''} x`.trim() });

function fixtureModel(): TraceModel {
  return {
    items: [
      item('FREQ-31', 'REQUEST', []),
      item('FR-NEWS-ALL-001', 'REQ', ['FREQ-31']),
      item('FR-NEWS-ALL-001-AC-01', 'AC', ['FR-NEWS-ALL-001']),
      item('FR-NEWS-ALL-001-AC-02', 'AC', ['FR-NEWS-ALL-001']),
      item('FR-NEWS-DETAIL-001', 'REQ', [], { outOfScopeParents: ['FREQ-05'] }),
      item('THR-NEWS-001', 'THR', []),
      item('SEC-NEWS-001', 'SEC', ['THR-NEWS-001']),
      item('API-NEWS-001', 'API', ['FR-NEWS-ALL-001', 'SEC-NEWS-001']),
      item('DD-NEWS-001', 'DD', ['API-NEWS-001']),
      item('DD-NEWS-002', 'DD', ['API-NEWS-001']),
      item('DD-NEWS-003', 'DD', ['API-NEWS-001'], { status: '廃止' }),
      item('DRV-NEWS-001', 'DRV', []),
      item('API-NEWS-002', 'API', ['DRV-NEWS-001']),
      item('DD-NEWS-005', 'DD', ['API-NEWS-002']),
    ],
    units: [
      unit('IMPL-NEWS-101', 'src/features/news/services/public.ts', 'fetchPublishedNews', ['DD-NEWS-001']),
      unit(undefined, 'src/app/news/page.tsx', '<file>', []),
      unit('IMPL-NEWS-105', 'src/lib/storage/news-images.ts', 'sign', ['DD-NEWS-005']),
    ],
    tests: [
      test('FR-NEWS-ALL-001-AC-01', 'e2e', 'e2e/FR-NEWS-ALL-001-a.spec.ts', 6),
      test('API-NEWS-001', 'integration', 'tests/integration/news.test.ts'),
      test('DD-NEWS-001', 'unit', 'tests/unit/news.test.ts'),
      test(null, 'e2e', 'e2e/FR-NEWS-DETAIL-001-b.spec.ts', 9),
    ],
    knownIdsOutsideScope: new Set(['FREQ-05']),
  };
}

const section = (md: string, heading: string) => {
  const start = md.indexOf(heading);
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start, next < 0 ? undefined : next);
};

describe('renderMatrix', () => {
  const md = renderMatrix(fixtureModel());

  it('3つの節を持つ', () => {
    expect(md).toContain('## 要求から下へ');
    expect(md).toContain('## 下から上へ');
    expect(md).toContain('## 食い違い');
  });

  it('要求から下へ: 要求 → 要件 → 受け入れ条件 → E2E を1行に並べる', () => {
    const down = section(md, '## 要求から下へ');
    expect(down).toMatch(/\| FREQ-31 [^|]*\| FR-NEWS-ALL-001 [^|]*\| FR-NEWS-ALL-001-AC-01 [^|]*\| `e2e\/FR-NEWS-ALL-001-a\.spec\.ts:6` \|/);
    expect(down).toMatch(/\| FR-NEWS-ALL-001-AC-02 [^|]*\| （なし） \|/);
  });

  it('範囲外の要求につながる要件は範囲外の印で載せ、要件と受け入れ条件を落とさない', () => {
    expect(section(md, '## 要求から下へ')).toMatch(/\| FREQ-05（範囲外） \| FR-NEWS-DETAIL-001 [^|]*\| （なし） \| （なし） \|/);
  });

  it('構造設計 → 結合テスト、DD → 単位 → 単体テストを並べ、廃止は載せない', () => {
    const down = section(md, '## 要求から下へ');
    expect(down).toMatch(/\| API-NEWS-001 [^|]*\| FR-NEWS-ALL-001、SEC-NEWS-001 \| `tests\/integration\/news\.test\.ts:3` \|/);
    expect(down).toMatch(/\| DD-NEWS-001 [^|]*\| API-NEWS-001 \| IMPL-NEWS-101 `src\/features\/news\/services\/public\.ts` の fetchPublishedNews \| `tests\/unit\/news\.test\.ts:3` \|/);
    expect(down).toMatch(/\| DD-NEWS-002 [^|]*\| API-NEWS-001 \| （なし） \| （なし） \|/);
    expect(down).not.toContain('DD-NEWS-003');
  });

  it('下から上へ: 単位ごとに DD・構造設計・要件・要求まで並べる', () => {
    const up = section(md, '## 下から上へ');
    expect(up).toMatch(/\| `src\/features\/news\/services\/public\.ts` の fetchPublishedNews \| IMPL-NEWS-101 \| DD-NEWS-001 \| API-NEWS-001 \| FR-NEWS-ALL-001、SEC-NEWS-001 \| FREQ-31、THR-NEWS-001 \|/);
    expect(up).toMatch(/\| `src\/app\/news\/page\.tsx` \| （なし） \| （なし） \| （なし） \| （なし） \| （なし） \|/);
  });
});

describe('renderMatrix の派生要件', () => {
  const md = renderMatrix(fixtureModel());
  it('上位の無い派生要件（DRV）を要件の段に載せる', () => {
    expect(section(md, '## 要求から下へ')).toMatch(/\| （派生要件） \| DRV-NEWS-001 [^|]*\| （なし） \| （なし） \|/);
  });
  it('下から上へで、DRV の下の単位は要件の列に DRV を出す', () => {
    expect(section(md, '## 下から上へ')).toMatch(/\| `src\/lib\/storage\/news-images\.ts` の sign \| IMPL-NEWS-105 \| DD-NEWS-005 \| API-NEWS-002 \| DRV-NEWS-001 \| （なし） \|/);
  });
});

describe('keepHandSection', () => {
  const gen = '# t\n\n## 生成\n\nA\n\n## 食い違い\n\n（手書き）\n';
  it('前の版の手書きの節を残す', () => {
    const prev = '# t\n\n## 生成\n\n古い\n\n## 食い違い\n\n- 文書は 10 件、コードは 12 件\n';
    expect(keepHandSection(gen, prev, '## 食い違い')).toBe('# t\n\n## 生成\n\nA\n\n## 食い違い\n\n- 文書は 10 件、コードは 12 件\n');
  });
  it('節が後ろに続いても、その節だけを差し替える', () => {
    const g = `${gen}\n## 後ろ\n\n新しい\n`;
    const prev = '## 食い違い\n\n手書き\n\n## 後ろ\n\n古い\n';
    expect(keepHandSection(g, prev, '## 食い違い')).toBe('# t\n\n## 生成\n\nA\n\n## 食い違い\n\n手書き\n\n## 後ろ\n\n新しい\n');
  });
  it('手書きの節の中に人が書いた ## の見出しでは切らない', () => {
    const prev = '# t\n\n## 食い違い\n\n- 一つ目\n\n## 人の見出し\n\n- 二つ目\n';
    expect(keepHandSection(gen, prev, '## 食い違い')).toBe('# t\n\n## 生成\n\nA\n\n## 食い違い\n\n- 一つ目\n\n## 人の見出し\n\n- 二つ目\n');
  });
  it('前の版が無いか節が無ければ生成のまま', () => {
    expect(keepHandSection(gen, undefined, '## 食い違い')).toBe(gen);
    expect(keepHandSection(gen, '# 古い\n', '## 食い違い')).toBe(gen);
  });
});

describe('test-gaps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parseUncovered は読めない行を標準エラーに警告し、人の書いた ## でも切らない', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const text = '## 届かない分岐\n\n（なし）\n- `src/a.ts:1` 理由\nsrc/b.ts の 3 行目は届かない\n## 人の見出し\n- `src/c.ts:2` 理由2\n';
    expect(parseUncovered(text).map((u) => u.file)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('src/b.ts の 3 行目は届かない'),
      expect.stringContaining('## 人の見出し'),
    ]);
  });

  it('自分の出した「届かない分岐」の節では警告しない', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    parseUncovered(renderTestGaps(fixtureModel(), []));
    parseUncovered(renderTestGaps(fixtureModel(), [{ file: 'src/a.ts', line: 3, reason: 'r' }]));
    expect(err).not.toHaveBeenCalled();
  });

  it('parseUncovered は「届かない分岐」の節の file:line と理由を読む', () => {
    const text = '## 試験の足りない項目\n\n- `src/x.ts:1` 違う節\n\n## 届かない分岐\n\n- `src/features/news/services/public.ts:42` 型の上で null にならない。確認: 未\n- src/app/news/page.tsx:7 — Next.js が先に弾く。確認: 済\n';
    expect(parseUncovered(text)).toEqual([
      { file: 'src/features/news/services/public.ts', line: 42, reason: '型の上で null にならない。確認: 未' },
      { file: 'src/app/news/page.tsx', line: 7, reason: 'Next.js が先に弾く。確認: 済' },
    ]);
  });

  it('renderTestGaps は足りない試験・ID の無い試験・届かない分岐を出し、読み直すと同じ物になる', () => {
    const uncovered = [{ file: 'src/a.ts', line: 3, reason: '届かない。確認: 未' }];
    const md = renderTestGaps(fixtureModel(), uncovered);
    const gaps = section(md, '## 試験の足りない項目');
    expect(gaps).toMatch(/\| FR-NEWS-ALL-001-AC-02 [^|]*\| E2E \|/);
    expect(gaps).toMatch(/\| DD-NEWS-002 [^|]*\| 単体テスト \|/);
    expect(gaps).not.toContain('FR-NEWS-ALL-001-AC-01 ');
    expect(gaps).not.toContain('DD-NEWS-003');
    expect(section(md, '## 名前に ID の無い試験')).toContain('`e2e/FR-NEWS-DETAIL-001-b.spec.ts:9`');
    expect(parseUncovered(md)).toEqual(uncovered);
  });
});
