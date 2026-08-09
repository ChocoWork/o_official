import {
	findRecordedSeriesRange,
	latestAdjacentRecordedPair,
	MONTHLY_KPI_FORMULAS,
	resolveRecordedKpiValue,
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
