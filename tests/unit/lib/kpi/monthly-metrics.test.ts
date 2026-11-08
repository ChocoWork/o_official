import {
	findRecordedSeriesRange,
	latestAdjacentRecordedPair,
	MONTHLY_KPI_FORMULAS,
	resolveRecordedKpiValue,
	SOURCE_METRICS,
	VALID_STORAGE_KEYS,
	isValidStorageKey,
	kpiOverrideStorageKey,
	sourceStorageKey,
} from '@/lib/kpi/monthly-metrics';

describe('MONTHLY_KPI_FORMULAS', () => {
	const followRateFormula = MONTHLY_KPI_FORMULAS.find((formula) => formula.key === 'follow_rate');

	it('新規フォロー数をプロフィールアクセス数で割ってフォロー率を算出する', () => {
		expect(followRateFormula?.compute({ new_followers: 25, profile_visits: 100 })).toBe(25);
	});

	it('プロフィールアクセス数が0の場合はフォロー率を算出しない', () => {
		expect(followRateFormula?.compute({ new_followers: 25, profile_visits: 0 })).toBeNull();
	});
});

describe('resolveRecordedKpiValue', () => {
	it('保存済みKPI上書き値を返す', () => {
		expect(resolveRecordedKpiValue({ 'kpi:roas': '3.2' }, 'roas')).toBe(3.2);
	});

	it('保存済み算出元だけからROASを算出する', () => {
		expect(
			resolveRecordedKpiValue(
				{ 'src:ad_revenue': '32000', 'src:ad_spend': '10000' },
				'roas',
			),
		).toBe(3.2);
	});

	it('必要な記録がないROASはnullを返す', () => {
		expect(resolveRecordedKpiValue({}, 'roas')).toBeNull();
	});

	it('保存済みの0を有効な値として返す', () => {
		expect(resolveRecordedKpiValue({ 'kpi:roas': '0' }, 'roas')).toBe(0);
	});
});

describe('recorded series helpers', () => {
	it('keeps the original index distance when values between records are missing', () => {
		expect(findRecordedSeriesRange([100, null, null, null, null, 200])).toEqual({
			first: 100,
			last: 200,
			periodCount: 6,
		});
	});

	it('returns only an adjacent pair at the end of the displayed period', () => {
		expect(latestAdjacentRecordedPair([100, 120, null, 180])).toBeNull();
		expect(latestAdjacentRecordedPair([100, null, 120, 180])).toEqual({
			previous: 120,
			current: 180,
		});
	});
});

describe('月の記録の受注高', () => {
	it('FREQ-573-AC-04: 月の記録の指標名が「受注高」になり、保存の鍵 src:paid_sales と kpi:sales は変わらない', () => {
		expect(SOURCE_METRICS.find((metric) => metric.key === 'paid_sales')?.label).toBe('受注高');
		const sales = MONTHLY_KPI_FORMULAS.find((formula) => formula.key === 'sales');
		expect(sales).toMatchObject({ label: '受注高', formulaText: '受注高' });
		expect(sourceStorageKey('paid_sales')).toBe('src:paid_sales');
		expect(kpiOverrideStorageKey('sales')).toBe('kpi:sales');
		expect(sales?.compute({ paid_sales: 90000 })).toBe(90000);
	});

	it('FREQ-573-AC-04: 客単価とLTVの算出式の文も「受注高」で書く', () => {
		const texts = ['aov', 'ltv'].map((key) => MONTHLY_KPI_FORMULAS.find((formula) => formula.key === key)?.formulaText);
		expect(texts).toEqual(['受注高 ÷ 有効注文数', '受注高 ÷ 顧客数']);
		expect(JSON.stringify([SOURCE_METRICS, MONTHLY_KPI_FORMULAS.map((f) => f.formulaText)])).not.toContain('売上額');
	});

	it('FREQ-573-AC-04: CVRは作成月の有効注文数を全注文数で割り、支払いを受けた日の月の有効注文数（客単価・セット購入率）とは別の源データを使う', () => {
		const cvr = MONTHLY_KPI_FORMULAS.find((formula) => formula.key === 'cvr');
		const aov = MONTHLY_KPI_FORMULAS.find((formula) => formula.key === 'aov');
		// 3月に作った4件のうち3件を支払い、3月に支払いを受けた注文は5件（前の月の分を含む）
		const source = { created_paid_orders: 3, paid_orders: 5, all_orders: 4, paid_sales: 50000 };
		expect(cvr?.compute(source)).toBe(75);
		expect(cvr?.formulaText).toBe('作成月の有効注文数 ÷ 全注文数');
		expect(aov?.compute(source)).toBe(10000);
		expect(cvr?.compute({ paid_orders: 5, all_orders: 4 })).toBeNull();
		expect(SOURCE_METRICS.find((metric) => metric.key === 'created_paid_orders')).toMatchObject({ group: 'order', unit: '件' });
		// 保存の鍵として DB の CHECK の形に合う
		expect(sourceStorageKey('created_paid_orders')).toMatch(/^(src|kpi):[A-Za-z0-9_]{1,64}$/);
		expect(VALID_STORAGE_KEYS.has('src:created_paid_orders')).toBe(true);
	});

	it('FREQ-573-AC-04: 保存できる鍵の集合を出し、保存の鍵の判定と同じ中身になる', () => {
		expect(VALID_STORAGE_KEYS.has('src:paid_sales')).toBe(true);
		expect(VALID_STORAGE_KEYS.has('kpi:sales')).toBe(true);
		expect(VALID_STORAGE_KEYS.has('kpi:unknown')).toBe(false);
		for (const key of VALID_STORAGE_KEYS) expect(isValidStorageKey(key)).toBe(true);
		expect(VALID_STORAGE_KEYS.size).toBe(SOURCE_METRICS.length + MONTHLY_KPI_FORMULAS.length);
	});
});
