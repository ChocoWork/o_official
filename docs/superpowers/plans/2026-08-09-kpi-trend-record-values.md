# KPI Trend Recorded Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KPI推移グラフと期間別推移表に、保存済み月次記録から解決できる実績値だけを表示し、未記録値のサンプル生成と補間を廃止する。

**Architecture:** 月次記録から単一KPI値を解決する純粋関数をKPIドメインへ追加し、KpiSectionが月次系列を `number | null` として組み立てる。共通Graphは欠損値を軸計算から除外し、連続する実値区間だけを線分として描画する。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Jest、React Testing Library、Playwright

## Global Constraints

- 月次の実績値は保存済みの `kpi:<KPIキー>` を優先し、なければ保存済みの `src:<算出元キー>` だけから算出する。
- 未記録値は `null` とし、0、補間値、サンプル波形へ変換しない。
- 数値0は有効な記録として保持する。
- 月次記録をシーズン・年度へ新規集約しない。
- ユーザーの既存作業中変更を上書きせず、今回の変更行だけを編集する。

---

### Task 1: 月次記録からKPI実績値を解決する

**Files:**
- Modify: `src/lib/kpi/monthly-metrics.ts`
- Test: `tests/unit/lib/kpi/monthly-metrics.test.ts`

**Interfaces:**
- Consumes: `Record<string, string | number | undefined>` 形式の1か月分保存値、既存の `MONTHLY_KPI_FORMULAS`、`sourceStorageKey()`、`kpiOverrideStorageKey()`
- Produces: `resolveRecordedKpiValue(monthValues, kpiKey): number | null`

- [ ] **Step 1: 上書き値、算出値、未記録、0を表す失敗テストを書く**

```ts
describe('resolveRecordedKpiValue', () => {
  it('保存済みKPI上書き値を返す', () => {
    expect(resolveRecordedKpiValue({ 'kpi:roas': '3.2' }, 'roas')).toBe(3.2);
  });

  it('保存済み算出元だけからROASを算出する', () => {
    expect(resolveRecordedKpiValue(
      { 'src:ad_revenue': '32000', 'src:ad_spend': '10000' },
      'roas',
    )).toBe(3.2);
  });

  it('必要な記録がないROASはnullを返す', () => {
    expect(resolveRecordedKpiValue({}, 'roas')).toBeNull();
  });

  it('保存済みの0を有効な値として返す', () => {
    expect(resolveRecordedKpiValue({ 'kpi:roas': '0' }, 'roas')).toBe(0);
  });
});
```

- [ ] **Step 2: テストが未実装理由で失敗することを確認する**

Run: `npm test -- --runInBand tests/unit/lib/kpi/monthly-metrics.test.ts`
Expected: FAIL（`resolveRecordedKpiValue` がexportされていない）

- [ ] **Step 3: 最小実装を追加する**

```ts
export function resolveRecordedKpiValue(
  monthValues: Record<string, string | number | undefined>,
  kpiKey: string,
): number | null {
  const parse = (value: string | number | undefined): number | null => {
    if (value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const override = parse(monthValues[kpiOverrideStorageKey(kpiKey)]);
  if (override !== null) return override;
  const formula = MONTHLY_KPI_FORMULAS.find((item) => item.key === kpiKey);
  if (!formula) return null;
  const source = Object.fromEntries(
    SOURCE_METRICS.flatMap((metric) => {
      const value = parse(monthValues[sourceStorageKey(metric.key)]);
      return value === null ? [] : [[metric.key, value]];
    }),
  );
  return formula.compute(source);
}
```

- [ ] **Step 4: 対象ユニットテストが通ることを確認する**

Run: `npm test -- --runInBand tests/unit/lib/kpi/monthly-metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Task 1をコミットする**

```bash
git add src/lib/kpi/monthly-metrics.ts tests/unit/lib/kpi/monthly-metrics.test.ts
git commit -m "test(kpi): resolve recorded monthly values"
```

### Task 2: Graphで欠損値を補間せず描画する

**Files:**
- Modify: `src/components/ui/Graph/Graph_types.ts`
- Modify: `src/components/ui/Graph/Graph.tsx`
- Create: `tests/unit/components/Graph.test.tsx`

**Interfaces:**
- Consumes: `GraphSeries.values: readonly (number | null)[]`
- Produces: 欠損を軸計算から除外し、nullで分割された連続区間ごとにpolylineを描画するGraph

- [ ] **Step 1: 欠損値の点と接続線を描かない失敗テストを書く**

```tsx
it('nullの月を点として描かず前後の値を接続しない', () => {
  const { container } = render(
    <Graph
      variant="line"
      categories={['4月', '5月', '6月']}
      series={[{ label: '実績', values: [3.2, null, 4.1] }]}
      ariaLabel="ROASの推移グラフ"
    />,
  );
  expect(container.querySelectorAll('circle')).toHaveLength(2);
  expect(container.querySelectorAll('polyline')).toHaveLength(2);
});
```

- [ ] **Step 2: 型または描画件数の不一致で失敗することを確認する**

Run: `npm test -- --runInBand tests/unit/components/Graph.test.tsx`
Expected: FAIL（null非対応、または1本のpolylineとして接続される）

- [ ] **Step 3: GraphSeriesの値型と軸計算を欠損対応にする**

```ts
export interface GraphSeries {
  label: string;
  values: readonly (number | null)[];
}

const numericValues = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null);
```

軸の最小・最大、右軸、積み上げ合計では `numericValues` または `value ?? 0` を用いる。棒、値ラベル、marker、dotはnull要素を返さない。

- [ ] **Step 4: 折れ線をnull境界で連続区間へ分割する**

```ts
type LinePoint = { index: number; value: number };

function contiguousLineSegments(values: readonly (number | null)[]): LinePoint[][] {
  return values.reduce<LinePoint[][]>((segments, value, index) => {
    if (value === null) return segments;
    const previousMissing = index === 0 || values[index - 1] === null;
    if (previousMissing) segments.push([]);
    segments[segments.length - 1].push({ index, value });
    return segments;
  }, []);
}
```

各区間は元のindexでx座標を求め、単独点の区間も空のpolylineと実点1個として保持する。

- [ ] **Step 5: Graphテストと既存型検査が通ることを確認する**

Run: `npm test -- --runInBand tests/unit/components/Graph.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Task 2をコミットする**

```bash
git add src/components/ui/Graph/Graph_types.ts src/components/ui/Graph/Graph.tsx tests/unit/components/Graph.test.tsx
git commit -m "fix(graph): preserve gaps in line series"
```

### Task 3: KPI推移を記録値系列へ切り替える

**Files:**
- Modify: `src/components/KpiSection.tsx`
- Modify: `e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts`

**Interfaces:**
- Consumes: `resolveRecordedKpiValue(monthValues, kpiKey)`、欠損対応済み `GraphSeries`
- Produces: 月次は保存記録のみ、シーズン・年度は接続済みKPIのみを返す `kpiSeriesValues(...): (number | null)[]`

- [ ] **Step 1: ROASの未記録・部分記録を表すE2E失敗テストを書く**

```ts
await page.route('**/api/admin/kpi/monthly-record**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        season: '2026SS',
        monthKeys: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
        values: { '2026-05': { 'kpi:roas': 3.2 } },
      },
    }),
  }),
);
await page.getByRole('button', { name: /ROAS/ }).click();
await expect(page.getByLabel('ROASの推移グラフ').locator('circle')).toHaveCount(1);
```

未記録レスポンスでは実績のcircleが0個、上記レスポンスでは1個になるアサーションを別テストにする。

- [ ] **Step 2: 現行サンプル波形により失敗することを確認する**

Run: `npx playwright test e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts --project=chromium --workers=1`
Expected: FAIL（ROASに6個のサンプル点が描画される）

- [ ] **Step 3: 月次系列を保存済み記録から組み立てる**

```ts
function kpiSeriesValues(
  definition: KpiCardDefinition,
  points: TrendPoint[],
  granularity: TrendGranularity,
  monthKeys: string[],
  recordValues: Record<string, Record<string, string>>,
): (number | null)[] {
  if (granularity === 'month') {
    return monthKeys.map((monthKey) =>
      resolveRecordedKpiValue(recordValues[monthKey] ?? {}, definition.key),
    );
  }
  const accessor = definition.connectedKey
    ? TREND_KPI_ACCESSORS[definition.connectedKey]
    : undefined;
  return accessor ? points.map(accessor) : points.map(() => null);
}
```

`sampleSparkSeries` と参照箇所を削除する。期間別推移表はnullを「—」として表示し、CAGRは最初と最後の実値が揃う場合だけ算出する。

- [ ] **Step 4: 実績系列が全欠損ならGraphへ実績系列を渡さない**

```ts
const hasTrendActual = trendActualValues.some((value) => value !== null);
const series: GraphSeries[] = hasTrendActual
  ? [{ label: '実績', values: trendActualValues, color: '#111111' }]
  : [];
```

目標・前年系列の表示条件は現行仕様を維持し、実績欠損をサンプル値で埋めない。

- [ ] **Step 5: E2Eと関連ユニットテストが通ることを確認する**

Run: `npm test -- --runInBand tests/unit/lib/kpi/monthly-metrics.test.ts tests/unit/components/Graph.test.tsx`
Expected: PASS

Run: `npx playwright test e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts --project=chromium --workers=1`
Expected: PASS（未記録0点、部分記録1点）

- [ ] **Step 6: Task 3をコミットする**

```bash
git add src/components/KpiSection.tsx e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts
git commit -m "fix(kpi): chart recorded trend values only"
```

### Task 4: 全体検証

**Files:**
- Verify: `src/lib/kpi/monthly-metrics.ts`
- Verify: `src/components/ui/Graph/Graph_types.ts`
- Verify: `src/components/ui/Graph/Graph.tsx`
- Verify: `src/components/KpiSection.tsx`
- Verify: `tests/unit/lib/kpi/monthly-metrics.test.ts`
- Verify: `tests/unit/components/Graph.test.tsx`
- Verify: `e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts`

**Interfaces:**
- Consumes: Tasks 1〜3の実装
- Produces: FREQ-262-AC-01、FREQ-262-AC-02を満たす検証結果

- [ ] **Step 1: 静的検査と関連テストを実行する**

Run: `npm run typecheck`
Expected: PASS

Run: `npm run lint`
Expected: PASS

Run: `npm test -- --runInBand`
Expected: PASS

- [ ] **Step 2: 本番ビルドのE2Eを実行する**

Run: `npx playwright test e2e/FR-ADMIN-017-trend-table-all-kpis.spec.ts --project=chromium --workers=1`
Expected: PASS

- [ ] **Step 3: セキュリティ監査を実行する**

Run: `bash .claude/skills/security-check/scripts/audit.sh`
Expected: PASS（今回変更による新規重大指摘なし）

- [ ] **Step 4: 差分を要件単位で監査する**

Run: `git diff --check HEAD~3..HEAD && git status --short`
Expected: 今回の変更に空白エラーがなく、既存のユーザー変更が保持されている。

- [ ] **Step 5: 検証結果をコミットする必要がある場合だけ記録する**

検証でコード修正が発生した場合、その修正対象だけを明示的にaddし、Conventional Commitでコミットする。検証結果だけの場合は追加コミットを作らない。
