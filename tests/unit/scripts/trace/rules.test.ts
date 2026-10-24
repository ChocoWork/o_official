/** @jest-environment node */
import { checkModel, type TraceModel } from '@/../scripts/trace/rules';
import type { TraceItem } from '@/../scripts/trace/model';
import type { CodeUnit } from '@/../scripts/trace/parse-code';
import type { TestRef } from '@/../scripts/trace/parse-tests';

const item = (o: Partial<TraceItem>): TraceItem => ({
  id: 'DD-NEWS-001', kind: 'DD', title: 't', file: 'd.md', line: 1, parents: ['API-NEWS-001'],
  outOfScopeParents: [], rationale: '下書きを出さない', status: '現行', oldIds: [], ...o,
});
const unit = (o: Partial<CodeUnit>): CodeUnit => ({
  file: 'src/lib/news-data.ts', line: 1, symbol: 'f', unitKind: 'function',
  implId: 'IMPL-NEWS-101', designIds: ['DD-NEWS-001'], remarks: '', ...o,
});
const test = (o: Partial<TestRef>): TestRef => ({
  id: 'DD-NEWS-001', level: 'unit', file: 'tests/unit/a.test.ts', line: 3, title: 'DD-NEWS-001 x', ...o,
});

/** 要求から単位・テストまで、どの決まりにも当たらない一続き。 */
function validModel(): TraceModel {
  return {
    items: [
      item({ id: 'SR-NEWS-001', kind: 'REQUEST', parents: [] }),
      item({ id: 'FR-NEWS-ALL-001', kind: 'REQ', parents: ['SR-NEWS-001'] }),
      item({ id: 'FR-NEWS-ALL-001-AC-01', kind: 'AC', parents: ['FR-NEWS-ALL-001'] }),
      item({ id: 'THR-NEWS-001', kind: 'THR', parents: [] }),
      item({ id: 'SEC-NEWS-001', kind: 'SEC', parents: ['THR-NEWS-001'] }),
      item({ id: 'DRV-NEWS-001', kind: 'DRV', parents: [] }),
      item({ id: 'ADR-0001', kind: 'ADR', parents: ['FR-NEWS-ALL-001'] }),
      item({ id: 'API-NEWS-001', kind: 'API', parents: ['FR-NEWS-ALL-001', 'SEC-NEWS-001', 'DRV-NEWS-001', 'ADR-0001'] }),
      item({ id: 'DD-NEWS-001', kind: 'DD', parents: ['API-NEWS-001'] }),
    ],
    units: [unit({})],
    tests: [
      test({ id: 'FR-NEWS-ALL-001-AC-01', level: 'e2e', file: 'e2e/a.spec.ts', title: 'FR-NEWS-ALL-001-AC-01 x' }),
      test({ id: 'API-NEWS-001', level: 'integration', file: 'tests/integration/a.test.ts', title: 'API-NEWS-001 x' }),
      test({}),
    ],
    knownIdsOutsideScope: new Set(),
  };
}

const rulesOf = (m: TraceModel) => checkModel(m).map((v) => v.rule);
const withItem = (id: string, o: Partial<TraceItem>): TraceModel => {
  const m = validModel();
  m.items = m.items.map((x) => (x.id === id ? { ...x, ...o } : x));
  return m;
};

describe('checkModel', () => {
  it('一続きがそろっていれば違反は無い', () => {
    expect(checkModel(validModel())).toEqual([]);
  });

  it('違反は決まりの名前・文・ファイル・行を持つ', () => {
    const v = checkModel(withItem('DD-NEWS-001', { status: '', file: 'docs/x.md', line: 7 }));
    expect(v).toEqual([{ rule: 'missing-status', message: expect.any(String), file: 'docs/x.md', line: 7 }]);
  });

  it('duplicate-id: 同じ ID の項目が2つあれば落とす', () => {
    const m = validModel();
    m.items.push(item({ file: 'e.md', line: 9 }));
    const v = checkModel(m).filter((x) => x.rule === 'duplicate-id');
    expect(v).toEqual([expect.objectContaining({ file: 'e.md', line: 9 })]);
  });

  it('bad-id: 見出しの ID の形が種類に合わなければ落とす', () => {
    expect(rulesOf(withItem('DD-NEWS-001', { id: 'DD-news-1' }))).toContain('bad-id');
  });

  it('missing-status: 状態が空なら落とす', () => {
    expect(rulesOf(withItem('DD-NEWS-001', { status: '' }))).toContain('missing-status');
  });

  it('根拠が決まり文句だけなら落とす', () => {
    const v = checkModel({ items: [item({ rationale: '仕様のため' })], units: [], tests: [], knownIdsOutsideScope: new Set() });
    expect(v.map((x) => x.rule)).toContain('missing-rationale');
  });

  it('missing-rationale: 空・決まり文句（句点付きも）は落とし、理由が続けば通す', () => {
    for (const r of ['', '  ', '要件のため', '仕様どおり。', '必要なため']) {
      expect(rulesOf(withItem('DD-NEWS-001', { rationale: r }))).toContain('missing-rationale');
    }
    expect(rulesOf(withItem('DD-NEWS-001', { rationale: '仕様のため。下書きを外へ出さない' }))).not.toContain('missing-rationale');
  });

  it('missing-rationale: 決まり文句を並べただけでも落とす', () => {
    for (const r of ['要件のため。仕様どおり。', '仕様のため 必要なため', '仕様のため、要件のため']) {
      expect(rulesOf(withItem('DD-NEWS-001', { rationale: r }))).toContain('missing-rationale');
    }
  });

  it('missing-parent: 上位が空なら落とし、REQUEST・DRV・THR は除く', () => {
    expect(rulesOf(withItem('DD-NEWS-001', { parents: [] }))).toContain('missing-parent');
    expect(rulesOf(withItem('FR-NEWS-ALL-001', { parents: [] }))).toContain('missing-parent');
    expect(rulesOf(validModel())).not.toContain('missing-parent');
  });

  it('wrong-parent-kind: 書けない種類の上位を落とす', () => {
    expect(rulesOf(withItem('DD-NEWS-001', { parents: ['API-NEWS-001', 'FR-NEWS-ALL-001'] }))).toContain('wrong-parent-kind');
    expect(rulesOf(withItem('FR-NEWS-ALL-001-AC-01', { parents: ['SEC-NEWS-001'] }))).not.toContain('wrong-parent-kind');
    expect(rulesOf(withItem('THR-NEWS-001', { parents: ['SR-NEWS-001'] }))).toContain('wrong-parent-kind');
  });

  it('wrong-parent-kind: 構造設計の上位が ADR だけなら落とす', () => {
    expect(rulesOf(withItem('API-NEWS-001', { parents: ['ADR-0001'] }))).toContain('wrong-parent-kind');
  });

  it('範囲外の印は、ほかの文書に在る ID なら通し、無い ID なら落とす', () => {
    const base = { units: [], tests: [] };
    const ok = checkModel({ ...base, items: [item({ id: 'API-NEWS-001', kind: 'API', parents: [], outOfScopeParents: ['SEC-001'] })], knownIdsOutsideScope: new Set(['SEC-001']) });
    expect(ok.filter((v) => v.rule === 'unknown-parent')).toEqual([]);
    const ng = checkModel({ ...base, items: [item({ id: 'API-NEWS-001', kind: 'API', parents: [], outOfScopeParents: ['SEC-999'] })], knownIdsOutsideScope: new Set() });
    expect(ng.map((v) => v.rule)).toContain('unknown-parent');
  });

  it('範囲外の印の ID が範囲内に在っても通す', () => {
    const m = withItem('DD-NEWS-001', { parents: [], outOfScopeParents: ['API-NEWS-001'] });
    expect(rulesOf(m)).not.toContain('unknown-parent');
  });

  it('unknown-parent: 範囲内に無い上位を落とす', () => {
    expect(rulesOf(withItem('DD-NEWS-001', { parents: ['API-NEWS-999'] }))).toContain('unknown-parent');
  });

  it('missing-child: 要る子が無ければ落とし、廃止は除く', () => {
    const m = validModel();
    m.items = m.items.filter((x) => x.id !== 'FR-NEWS-ALL-001-AC-01');
    m.tests = m.tests.filter((t) => t.level !== 'e2e');
    expect(checkModel(m).filter((v) => v.rule === 'missing-child').map((v) => v.message)).toEqual([
      expect.stringContaining('FR-NEWS-ALL-001'),
    ]);
    const retired = withItem('FR-NEWS-ALL-001', { status: '廃止' });
    retired.items = retired.items.filter((x) => x.id !== 'FR-NEWS-ALL-001-AC-01');
    expect(checkModel(retired).filter((v) => v.rule === 'missing-child' && v.message.includes('FR-NEWS-ALL-001'))).toEqual([]);
  });

  it('missing-child: AC の e2e・構造設計の結合テストと DD・DD の単体テストと単位', () => {
    const noE2e = validModel();
    noE2e.tests = noE2e.tests.filter((t) => t.level !== 'e2e');
    expect(rulesOf(noE2e)).toContain('missing-child');
    const noInt = validModel();
    noInt.tests = noInt.tests.filter((t) => t.level !== 'integration');
    expect(rulesOf(noInt)).toContain('missing-child');
    const noUnitTest = validModel();
    noUnitTest.tests = noUnitTest.tests.filter((t) => t.level !== 'unit');
    expect(rulesOf(noUnitTest)).toContain('missing-child');
    const noCode = validModel();
    noCode.units = [];
    expect(rulesOf(noCode)).toContain('missing-child');
    const noDd = validModel();
    noDd.items = noDd.items.filter((x) => x.id !== 'DD-NEWS-001');
    expect(checkModel(noDd).filter((v) => v.rule === 'missing-child').map((v) => v.file + v.message)).toEqual([
      expect.stringContaining('API-NEWS-001'),
    ]);
  });

  it('missing-child: REQUEST・THR・SEC・DRV・ADR に要る子が無ければ落とす', () => {
    const missingOf = (m: TraceModel, id: string) =>
      checkModel(m).filter((v) => v.rule === 'missing-child' && v.message.startsWith(`${id} `));
    const apiParents = (drop: string) => withItem('API-NEWS-001', {
      parents: ['FR-NEWS-ALL-001', 'SEC-NEWS-001', 'DRV-NEWS-001', 'ADR-0001'].filter((p) => p !== drop),
    });
    expect(missingOf(withItem('FR-NEWS-ALL-001', { parents: [] }), 'SR-NEWS-001')).toHaveLength(1);
    expect(missingOf(withItem('SEC-NEWS-001', { parents: [] }), 'THR-NEWS-001')).toHaveLength(1);
    expect(missingOf(apiParents('SEC-NEWS-001'), 'SEC-NEWS-001')).toHaveLength(1);
    expect(missingOf(apiParents('DRV-NEWS-001'), 'DRV-NEWS-001')).toHaveLength(1);
    expect(missingOf(apiParents('ADR-0001'), 'ADR-0001')).toHaveLength(1);
    expect(missingOf(validModel(), 'SR-NEWS-001')).toEqual([]);
  });

  it('missing-child: DRV の子は構造設計だけで、DD では満たさない', () => {
    const m = withItem('API-NEWS-001', { parents: ['FR-NEWS-ALL-001', 'SEC-NEWS-001', 'ADR-0001'] });
    m.items = m.items.map((x) => (x.id === 'DD-NEWS-001' ? { ...x, parents: ['API-NEWS-001', 'DRV-NEWS-001'] } : x));
    expect(checkModel(m).filter((v) => v.rule === 'missing-child').map((v) => v.message)).toEqual([
      expect.stringMatching(/^DRV-NEWS-001 /),
    ]);
  });

  it('missing-child: SEC の子は AC だけでも満たす', () => {
    const m = validModel();
    m.items = m.items.map((x) =>
      x.id === 'API-NEWS-001' ? { ...x, parents: ['FR-NEWS-ALL-001', 'DRV-NEWS-001', 'ADR-0001'] } : x.id === 'FR-NEWS-ALL-001-AC-01' ? { ...x, parents: ['FR-NEWS-ALL-001', 'SEC-NEWS-001'] } : x,
    );
    expect(checkModel(m)).toEqual([]);
  });

  it('retired-reference: 廃止の項目を、廃止でない項目・単位・テストが指せば落とす', () => {
    const v = checkModel(withItem('DD-NEWS-001', { status: '廃止' })).filter((x) => x.rule === 'retired-reference');
    expect(v.map((x) => x.file)).toEqual(['src/lib/news-data.ts', 'tests/unit/a.test.ts']);
    const byItem = checkModel(withItem('API-NEWS-001', { status: '廃止' })).filter((x) => x.rule === 'retired-reference');
    expect(byItem.map((x) => x.message)).toEqual([expect.stringContaining('DD-NEWS-001'), expect.stringContaining('API-NEWS-001')]);
    const both = withItem('API-NEWS-001', { status: '廃止' });
    both.items = both.items.map((x) => (x.id === 'DD-NEWS-001' ? { ...x, status: '廃止' } : x));
    both.units = [];
    both.tests = both.tests.filter((t) => t.level === 'e2e');
    expect(rulesOf(both)).not.toContain('retired-reference');
  });

  it('missing-impl: @impl が無い単位、IMPL でない @impl を落とす', () => {
    const m = validModel();
    m.units = [unit({ implId: undefined, line: 4 }), unit({ implId: 'DD-NEWS-001', symbol: 'g' })];
    expect(checkModel(m).filter((v) => v.rule === 'missing-impl')).toHaveLength(2);
    expect(rulesOf(validModel())).not.toContain('missing-impl');
  });

  it('bad-design-link: @design が1つでない・DD でない・範囲内に無いなら落とす', () => {
    const cases: Array<[string[], string]> = [
      [[], '1つでない（0 個）'],
      [['DD-NEWS-001', 'DD-NEWS-002'], '1つでない（2 個）'],
      [['API-NEWS-001'], 'API-NEWS-001 が DD でない'],
      [['DD-NEWS-999'], 'DD-NEWS-999 が範囲内に無い'],
    ];
    for (const [designIds, fragment] of cases) {
      const m = validModel();
      m.units = [unit({ designIds }), unit({ implId: 'IMPL-NEWS-102' })];
      const v = checkModel(m).filter((x) => x.rule === 'bad-design-link');
      expect(v.map((x) => x.message)).toEqual([expect.stringContaining(fragment)]);
    }
  });

  it('duplicate-impl: 同じ IMPL が2つの単位にあれば落とす', () => {
    const m = validModel();
    m.units.push(unit({ symbol: 'g', line: 20 }));
    expect(checkModel(m).filter((v) => v.rule === 'duplicate-impl')).toEqual([expect.objectContaining({ line: 20 })]);
  });

  it('untagged-test: 名前に ID の無いテストを落とす', () => {
    const m = validModel();
    m.tests.push(test({ id: null, title: '名前だけ' }));
    expect(rulesOf(m)).toContain('untagged-test');
  });

  it('単体テストが構造設計を指したら段の誤りで落とす', () => {
    const v = checkModel({
      items: [item({ id: 'API-NEWS-001', kind: 'API', parents: ['FR-NEWS-ALL-001'] })],
      units: [], knownIdsOutsideScope: new Set(),
      tests: [{ id: 'API-NEWS-001', level: 'unit', file: 'tests/unit/a.test.ts', line: 3, title: 'API-NEWS-001 x' }],
    });
    expect(v.map((x) => x.rule)).toContain('wrong-test-level');
  });

  it('wrong-test-level: e2e は AC、integration は構造設計だけ', () => {
    const e2e = validModel();
    e2e.tests.push(test({ id: 'FR-NEWS-ALL-001', level: 'e2e' }));
    expect(rulesOf(e2e)).toContain('wrong-test-level');
    const integ = validModel();
    integ.tests.push(test({ id: 'DD-NEWS-001', level: 'integration' }));
    expect(rulesOf(integ)).toContain('wrong-test-level');
  });

  it('unknown-test-id: 範囲内に無い ID のテストを落とす', () => {
    const m = validModel();
    m.tests.push(test({ id: 'DD-NEWS-999' }));
    expect(rulesOf(m)).toContain('unknown-test-id');
  });
});
