import { buildCumulativeSummary, type CumulativeEntry } from '@/lib/finance/cumulative';
import type { FixedAsset } from '@/lib/finance/depreciation';

function entry(partial: Partial<CumulativeEntry> & Pick<CumulativeEntry, 'amount'>): CumulativeEntry {
	return {
		entryType: 'expense',
		date: '2026-04-01',
		category: '広告宣伝費',
		...partial,
	};
}

const ASSET: FixedAsset = {
	id: 1,
	name: 'ミシン',
	account: '工具器具備品',
	acquiredOn: '2026-01-10',
	acquisitionCost: 600_000,
	usefulLife: 6,
	method: 'straightLine',
	businessUseRatio: 100,
	disposedOn: null,
	memo: '',
};

describe('buildCumulativeSummary', () => {
	it('複数年の売上・費用を累計する', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-05-01', amount: 500_000, entryType: 'income', category: '売上高' }),
				entry({ date: '2026-06-01', amount: 200_000, category: '仕入高' }),
				entry({ date: '2027-05-01', amount: 800_000, entryType: 'income', category: '売上高' }),
				entry({ date: '2027-06-01', amount: 300_000, category: '仕入高' }),
			],
			[],
			2027,
		);

		expect(summary.sales).toBe(1_300_000);
		expect(summary.expenses).toBe(500_000);
		expect(summary.netIncome).toBe(800_000);
		expect(summary.entryCount).toBe(4);
		expect(summary.firstYear).toBe(2026);
	});

	it('対象年より後の取引は含めない', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-05-01', amount: 500_000, entryType: 'income', category: '売上高' }),
				entry({ date: '2027-01-05', amount: 900_000, entryType: 'income', category: '売上高' }),
			],
			[],
			2026,
		);
		expect(summary.sales).toBe(500_000);
		expect(summary.entryCount).toBe(1);
	});

	it('売上値引・返品を累計売上から控除する', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-05-01', amount: 500_000, entryType: 'income', category: '売上高' }),
				entry({ date: '2026-07-01', amount: 40_000, category: '売上値引・返品' }),
			],
			[],
			2026,
		);
		expect(summary.sales).toBe(460_000);
	});

	it('仕入値引・返品を累計費用から控除する', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-05-01', amount: 200_000, category: '仕入高' }),
				entry({ date: '2026-07-01', amount: 20_000, entryType: 'income', category: '仕入値引・返品' }),
			],
			[],
			2026,
		);
		expect(summary.expenses).toBe(180_000);
	});

	it('資産・負債科目は損益に含めない', () => {
		const summary = buildCumulativeSummary(
			[
				// 固定資産の取得は費用ではない
				entry({ date: '2026-01-10', amount: 600_000, category: '工具器具備品' }),
				// 買掛金の支払も費用ではない
				entry({ date: '2026-02-10', amount: 100_000, category: '買掛金' }),
			],
			[],
			2026,
		);
		expect(summary.expenses).toBe(0);
		expect(summary.sales).toBe(0);
	});

	it('減価償却費を年数分だけ累計費用へ足す', () => {
		// 600,000 × 0.167 = 100,200／年
		const oneYear = buildCumulativeSummary([], [ASSET], 2026);
		expect(oneYear.expenses).toBe(100_200);

		const threeYears = buildCumulativeSummary([], [ASSET], 2028);
		expect(threeYears.expenses).toBe(100_200 * 3);
	});

	it('事業専用割合を按分した額を累計する', () => {
		const summary = buildCumulativeSummary(
			[],
			[{ ...ASSET, businessUseRatio: 70 }],
			2026,
		);
		// 100,200 × 70% = 70,140
		expect(summary.expenses).toBe(70_140);
	});

	it('累計設備投資は対象年までに取得した資産の取得価額合計', () => {
		const summary = buildCumulativeSummary(
			[],
			[ASSET, { ...ASSET, id: 2, acquiredOn: '2028-03-01', acquisitionCost: 450_000 }],
			2026,
		);
		expect(summary.capitalInvestment).toBe(600_000);

		const later = buildCumulativeSummary(
			[],
			[ASSET, { ...ASSET, id: 2, acquiredOn: '2028-03-01', acquisitionCost: 450_000 }],
			2028,
		);
		expect(later.capitalInvestment).toBe(1_050_000);
	});

	it('取引も資産も無ければ全て0', () => {
		const summary = buildCumulativeSummary([], [], 2026);
		expect(summary).toMatchObject({
			sales: 0,
			expenses: 0,
			netIncome: 0,
			capitalInvestment: 0,
			entryCount: 0,
			firstYear: null,
		});
	});

	it('売上と減価償却を合わせた累計利益を出す', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-05-01', amount: 900_000, entryType: 'income', category: '売上高' }),
				entry({ date: '2026-06-01', amount: 200_000, category: '仕入高' }),
			],
			[ASSET],
			2026,
		);
		// 900,000 − (200,000 + 100,200)
		expect(summary.netIncome).toBe(599_800);
	});
});

describe('buildCumulativeSummary の費用内訳', () => {
	it('売上原価（当期仕入高）と販管費（経費）を分けて累計する', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2025-03-01', amount: 300_000, category: '仕入高' }),
				entry({ date: '2026-03-01', amount: 200_000, category: '仕入高' }),
				entry({ date: '2026-04-01', amount: 120_000, category: '広告宣伝費' }),
			],
			[],
			2026,
		);

		expect(summary.costOfSales).toBe(500_000);
		expect(summary.operatingExpenses).toBe(120_000);
		// 内訳の合計は累計費用に一致する
		expect(summary.costOfSales + summary.operatingExpenses).toBe(summary.expenses);
	});

	it('仕入値引・返品は累計売上原価から控除する', () => {
		const summary = buildCumulativeSummary(
			[
				entry({ date: '2026-03-01', amount: 300_000, category: '仕入高' }),
				entry({
					date: '2026-03-10',
					amount: 50_000,
					entryType: 'income',
					category: '仕入値引・返品',
				}),
			],
			[],
			2026,
		);

		expect(summary.costOfSales).toBe(250_000);
		expect(summary.operatingExpenses).toBe(0);
	});

	it('減価償却費は販管費（経費）へ積む', () => {
		const summary = buildCumulativeSummary([], [ASSET], 2026);

		expect(summary.operatingExpenses).toBe(100_200);
		expect(summary.costOfSales).toBe(0);
		expect(summary.expenses).toBe(100_200);
	});

	it('営業外費用は内訳に入らないが累計費用には効く', () => {
		const summary = buildCumulativeSummary(
			[entry({ date: '2026-06-01', amount: 10_000, category: '支払利息' })],
			[],
			2026,
		);

		expect(summary.costOfSales).toBe(0);
		expect(summary.operatingExpenses).toBe(0);
		expect(summary.expenses).toBe(10_000);
	});
});
