/** @jest-environment node */
import { impactOf } from '@/../scripts/trace/impact';
import type { TraceItem } from '@/../scripts/trace/model';
import type { CodeUnit } from '@/../scripts/trace/parse-code';
import type { TestRef } from '@/../scripts/trace/parse-tests';
import type { TraceModel } from '@/../scripts/trace/rules';

const item = (id: string, kind: TraceItem['kind'], parents: string[]): TraceItem => ({
  id, kind, title: `${id} の題`, file: 'docs/a.md', line: 1, parents, outOfScopeParents: [],
  rationale: 'r', status: '現行', oldIds: [],
});
const unit = (implId: string, file: string, symbol: string, designIds: string[]): CodeUnit => ({
  file, line: 1, symbol, unitKind: 'function', implId, designIds, remarks: '',
});
const test = (id: string, level: TestRef['level'], file: string): TestRef => ({ id, level, file, line: 3, title: `${id} x` });

/** REQUEST FREQ-31 → FR-NEWS-ALL-001 → AC-01、API-NEWS-001 → DD-NEWS-001 ← IMPL-NEWS-101・102 */
function fixtureModel(): TraceModel {
  return {
    items: [
      item('FREQ-31', 'REQUEST', []),
      item('FR-NEWS-ALL-001', 'REQ', ['FREQ-31']),
      item('FR-NEWS-ALL-001-AC-01', 'AC', ['FR-NEWS-ALL-001']),
      item('API-NEWS-001', 'API', ['FR-NEWS-ALL-001']),
      item('DD-NEWS-001', 'DD', ['API-NEWS-001']),
      item('DD-NEWS-002', 'DD', ['API-NEWS-001']),
    ],
    units: [
      unit('IMPL-NEWS-101', 'src/features/news/services/public.ts', 'fetchPublishedNews', ['DD-NEWS-001']),
      unit('IMPL-NEWS-102', 'src/app/api/news/route.ts', '<file>', ['DD-NEWS-001']),
      unit('IMPL-NEWS-103', 'src/lib/news-data.ts', 'other', ['DD-NEWS-002']),
    ],
    tests: [
      test('FR-NEWS-ALL-001-AC-01', 'e2e', 'e2e/FR-NEWS-ALL-001-a.spec.ts'),
      test('API-NEWS-001', 'integration', 'tests/integration/news.test.ts'),
      test('DD-NEWS-001', 'unit', 'tests/unit/news.test.ts'),
      test('DD-NEWS-002', 'unit', 'tests/unit/news-data.test.ts'),
    ],
    knownIdsOutsideScope: new Set(),
  };
}

describe('impactOf', () => {
  it('impactOf は IMPL から要求までと、同じ DD の兄弟とテストを返す', () => {
    const m = fixtureModel();
    const r = impactOf(m, 'IMPL-NEWS-101');
    expect(r.upstream.map((i) => i.id)).toEqual(expect.arrayContaining(['DD-NEWS-001', 'API-NEWS-001', 'FR-NEWS-ALL-001', 'FREQ-31']));
    expect(r.siblings.map((u) => u.implId)).toEqual(['IMPL-NEWS-102']);
    expect(r.tests.map((t) => t.id)).toEqual(expect.arrayContaining(['DD-NEWS-001', 'API-NEWS-001', 'FR-NEWS-ALL-001-AC-01']));
  });

  it('impactOf はファイルの場所でも引ける', () => {
    expect(impactOf(fixtureModel(), 'src/features/news/services/public.ts').units.length).toBeGreaterThan(0);
  });

  it('IMPL からは別の DD の単体テストと、要件の外の子を出さない', () => {
    const r = impactOf(fixtureModel(), 'IMPL-NEWS-101');
    expect(r.units.map((u) => u.implId)).toEqual(['IMPL-NEWS-101']);
    expect(r.upstream.map((i) => i.id)).not.toContain('DD-NEWS-002');
    expect(r.tests.map((t) => t.file)).not.toContain('tests/unit/news-data.test.ts');
    expect(r.downstream).toEqual([]);
  });

  it('要件の ID からは下の項目と単位を全部返す', () => {
    const r = impactOf(fixtureModel(), 'FR-NEWS-ALL-001');
    expect(r.upstream.map((i) => i.id)).toEqual(['FREQ-31']);
    expect(r.downstream.map((i) => i.id)).toEqual(['FR-NEWS-ALL-001-AC-01', 'API-NEWS-001', 'DD-NEWS-001', 'DD-NEWS-002']);
    expect(r.units.map((u) => u.implId)).toEqual(['IMPL-NEWS-101', 'IMPL-NEWS-102', 'IMPL-NEWS-103']);
    expect(r.tests).toHaveLength(4);
    expect(r.siblings).toEqual([]);
  });

  it('ファイルの場所は \\ 区切りと ./ 始まりでも引ける', () => {
    expect(impactOf(fixtureModel(), '.\\src\\app\\api\\news\\route.ts').units.map((u) => u.implId)).toEqual(['IMPL-NEWS-102']);
  });

  it('見つからなければ全部空', () => {
    expect(impactOf(fixtureModel(), 'IMPL-NEWS-999')).toEqual({ upstream: [], downstream: [], units: [], tests: [], siblings: [] });
  });
});
