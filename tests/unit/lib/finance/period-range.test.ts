import { buildCumulativeSummary } from '@/lib/finance/cumulative';
import { buildCumulativeBalanceTrend } from '@/lib/finance/cumulative-balance-trend';
import type { FixedAsset, DepreciationForYear } from '@/lib/finance/depreciation';
import {
	buildDepreciationEntries,
	buildGeneralLedger,
	buildJournal,
	type FinanceEntry,
} from '@/lib/finance/journal';
import { buildMonthlyCashTrend } from '@/lib/finance/overview';
import {
	isDateInPeriod,
	jstStartOfDayIso,
	periodMonthIndexOf,
	periodMonthsOf,
	periodRangeOf,
} from '@/lib/finance/period-range';
import { buildAllowanceEntries, buildInventoryEntries, EMPTY_YEAR_END_ADJUSTMENT } from '@/lib/finance/year-end';

const MID_YEAR = { startsOn: '2026-07-15', endsOn: '2027-07-14' };
const CALENDAR_2026 = { startsOn: '2026-01-01', endsOn: '2026-12-31' };

function entry(partial: Partial<FinanceEntry> & Pick<FinanceEntry, 'id' | 'amount' | 'date'>): FinanceEntry {
	return {
		entryType: 'expense',
		category: '広告宣伝費',
		item: '広告',
		partner: '',
		paymentMethod: '現金',
		memo: '',
		seasonTag: null,
		...partial,
	};
}

const ASSET: FixedAsset = {
	id: 7, name: 'ミシン', account: '工具器具備品', acquiredOn: '2026-01-10',
	acquisitionCost: 600_000, usefulLife: 6, method: 'straightLine',
	businessUseRatio: 100, disposedOn: null, memo: '',
};

describe('periodRangeOf', () => {
	it('FREQ-557-AC-03: 期間の端の日と、終わりの次の日の0時（日本時間）をUTCにした時刻を返す', () => {
		expect(periodRangeOf(CALENDAR_2026)).toEqual({
			from: '2026-01-01',
			to: '2026-12-31',
			toExclusiveIso: '2026-12-31T15:00:00.000Z',
		});
		expect(periodRangeOf(MID_YEAR)).toEqual({
			from: '2026-07-15',
			to: '2027-07-14',
			toExclusiveIso: '2027-07-14T15:00:00.000Z',
		});
		expect(jstStartOfDayIso('2026-07-15')).toBe('2026-07-14T15:00:00.000Z');
		expect(() => periodRangeOf({ startsOn: '2027-01-01', endsOn: '2026-12-31' })).toThrow(RangeError);
		expect(() => periodRangeOf({ startsOn: '2026-02-30', endsOn: '2026-12-31' })).toThrow(RangeError);
	});

	it('FREQ-557-AC-03: 日付と日時の先頭の日で期間に入るかを決め、月の何番目かを返す', () => {
		expect(isDateInPeriod('2026-07-15', MID_YEAR)).toBe(true);
		expect(isDateInPeriod('2027-07-14', MID_YEAR)).toBe(true);
		expect(isDateInPeriod('2026-07-14', MID_YEAR)).toBe(false);
		expect(isDateInPeriod('2027-07-15T00:00:00+09:00', MID_YEAR)).toBe(false);
		const months = periodMonthsOf(MID_YEAR);
		expect(months).toHaveLength(13);
		expect(months[0]).toEqual({ key: '2026-07', month: 7, label: '2026年7月', startsOn: '2026-07-15', endsOn: '2026-07-31' });
		expect(months[12]).toEqual({ key: '2027-07', month: 7, label: '2027年7月', startsOn: '2027-07-01', endsOn: '2027-07-14' });
		expect(periodMonthIndexOf(months, '2027-01-31')).toBe(6);
		expect(periodMonthIndexOf(months, '2027-07-15')).toBe(-1);
	});
});

describe('期間の端で数える関数', () => {
	it('FREQ-557-AC-03: 期間が7月15日から翌年7月14日でも累計と年末の仕訳と推移が動く', () => {
		const entries = [
			entry({ id: 1, date: '2026-07-01', amount: 1_000, entryType: 'income', category: '売上高' }),
			entry({ id: 2, date: '2026-07-15', amount: 300 }),
			entry({ id: 3, date: '2027-01-10', amount: 5_000, entryType: 'income', category: '売上高' }),
			entry({ id: 4, date: '2027-07-14', amount: 200 }),
			entry({ id: 5, date: '2027-07-15', amount: 9_999 }),
		];

		// 累計: 期間の終わりの日まで数え、次の日の取引は入れない。
		const cumulative = buildCumulativeSummary(entries, [], MID_YEAR.endsOn);
		expect(cumulative.entryCount).toBe(4);
		expect(cumulative.sales).toBe(6_000);
		expect(cumulative.expenses).toBe(500);

		// 推移: 期首は期間の前、月は13本（両端の7月は欠けた月）。
		const trend = buildCumulativeBalanceTrend(entries, MID_YEAR);
		expect(trend.openingBalance).toBe(1_000);
		expect(trend.monthly).toHaveLength(13);
		expect(trend.monthly.map((point) => point.label)).toEqual(periodMonthsOf(MID_YEAR).map((month) => month.label));
		expect(trend.monthly[0]).toEqual(expect.objectContaining({ key: '2026-07', net: -300, balance: 700 }));
		expect(trend.monthly[6]).toEqual(expect.objectContaining({ key: '2027-01', net: 5_000, balance: 5_700 }));
		expect(trend.monthly[12]).toEqual(expect.objectContaining({ key: '2027-07', net: -200, balance: 5_500 }));
		expect(trend).toEqual(expect.objectContaining({ annualIncome: 5_000, annualExpense: 500, closingBalance: 5_500 }));

		// 年末の仕訳: 減価償却・棚卸・引当金は期間の終わりの日に立つ。
		const depreciationRow: DepreciationForYear = {
			asset: ASSET, months: 12, depreciation: 100_000, businessExpense: 100_000, privatePortion: 0,
			openingBookValue: 600_000, closingBookValue: 500_000, accumulated: 100_000, isFinalYear: false,
		};
		const closingEntries = [
			...buildDepreciationEntries([depreciationRow], MID_YEAR.endsOn),
			...buildInventoryEntries({ ...EMPTY_YEAR_END_ADJUSTMENT, closingInventoryGoods: 10_000 }, new Map([['1310', 4_000]]), MID_YEAR.endsOn),
			...buildAllowanceEntries({ ...EMPTY_YEAR_END_ADJUSTMENT, allowanceForDoubtful: 1_000 }, MID_YEAR.endsOn),
		];
		expect(closingEntries.map((row) => row.date)).toEqual(Array(4).fill('2027-07-14'));
		expect(closingEntries.map((row) => row.number)).toEqual([
			'JE-20270714-D001', 'JE-20270714-I01', 'JE-20270714-I02', 'JE-20270714-A01',
		]);

		// 資金の推移: 期間の月ごとに現金の動きを束ね、期間の外の行は数えない。
		const ledger = buildGeneralLedger(buildJournal(entries, 'corporation'), new Map([['1010', 50_000]]));
		const cash = buildMonthlyCashTrend(ledger, MID_YEAR);
		expect(cash.points).toHaveLength(13);
		expect(cash.points[0]).toEqual(expect.objectContaining({ label: '2026年7月', net: -300, balance: 49_700 }));
		expect(cash.points[6]).toEqual(expect.objectContaining({ label: '2027年1月', net: 5_000, balance: 54_700 }));
		expect(cash.points[12]).toEqual(expect.objectContaining({ label: '2027年7月', net: -200, balance: 54_500 }));
	});

	it('FREQ-557-AC-03: 個人の1月1日から12月31日の期間では従来の画面の数字が同じ', () => {
		const entries = [
			entry({ id: 1, date: '2025-12-20', amount: 100_000, entryType: 'income', category: '売上高' }),
			entry({ id: 2, date: '2026-01-10', amount: 20_000, entryType: 'income', category: '売上高' }),
			entry({ id: 3, date: '2026-12-31', amount: 5_000 }),
			entry({ id: 4, date: '2027-01-01', amount: 7_000 }),
		];
		const trend = buildCumulativeBalanceTrend(entries, CALENDAR_2026);
		expect(trend.monthly.map((point) => point.label)).toEqual(
			['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
		);
		expect(trend.monthly.map((point) => point.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(trend).toEqual(expect.objectContaining({ openingBalance: 100_000, annualIncome: 20_000, annualExpense: 5_000, closingBalance: 115_000 }));
		expect(buildCumulativeSummary(entries, [], CALENDAR_2026.endsOn).entryCount).toBe(3);

		const cash = buildMonthlyCashTrend(buildGeneralLedger(buildJournal(entries, 'soleProprietor')), CALENDAR_2026);
		expect(cash.points.map((point) => point.label)).toEqual(
			['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
		);
		expect(cash.points[11].net).toBe(-5_000);
		expect(buildAllowanceEntries({ ...EMPTY_YEAR_END_ADJUSTMENT, allowanceForDoubtful: 1 }, CALENDAR_2026.endsOn)[0].number)
			.toBe('JE-20261231-A01');
	});
});
