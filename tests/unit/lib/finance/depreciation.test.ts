import {
	depreciationForYear,
	depreciationSchedule,
	straightLineRate,
	type FixedAsset,
} from '@/lib/finance/depreciation';

function asset(partial: Partial<FixedAsset> = {}): FixedAsset {
	return {
		id: 1,
		name: 'ミシン',
		account: '工具器具備品',
		acquiredOn: '2026-01-01',
		acquisitionCost: 600000,
		usefulLife: 6,
		method: 'straightLine',
		businessUseRatio: 100,
		disposedOn: null,
		memo: '',
		...partial,
	};
}

describe('straightLineRate', () => {
	// 国税庁「減価償却資産の償却率表」の定額法償却率と一致すること
	const table: Array<[number, number]> = [
		[2, 0.5],
		[3, 0.334],
		[4, 0.25],
		[5, 0.2],
		[6, 0.167],
		[7, 0.143],
		[8, 0.125],
		[9, 0.112],
		[10, 0.1],
		[12, 0.084],
		[13, 0.077],
		[15, 0.067],
		[17, 0.059],
		[20, 0.05],
	];

	for (const [life, rate] of table) {
		it(`耐用年数${life}年 → ${rate}`, () => {
			expect(straightLineRate(life)).toBeCloseTo(rate, 3);
		});
	}
});

describe('定額法（手計算との一致）', () => {
	// 取得価額600,000／耐用年数6年／償却率0.167 → 年間 600,000×0.167 = 100,200
	it('期首取得なら初年度から満額（12ヶ月）償却する', () => {
		const result = depreciationForYear(asset(), 2026);
		expect(result.months).toBe(12);
		expect(result.depreciation).toBe(100_200);
		expect(result.openingBookValue).toBe(600_000);
		expect(result.closingBookValue).toBe(499_800);
		expect(result.accumulated).toBe(100_200);
	});

	// 年の中途（10月）取得 → 使用月数3ヶ月 → 100,200 × 3/12 = 25,050
	it('年の中途取得は使用月数で月割する', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2026-10-15' }), 2026);
		expect(result.months).toBe(3);
		expect(result.depreciation).toBe(25_050);
		expect(result.closingBookValue).toBe(574_950);
	});

	it('中途取得の翌年は満額償却に戻る', () => {
		const target = asset({ acquiredOn: '2026-10-15' });
		const second = depreciationForYear(target, 2027);
		expect(second.months).toBe(12);
		expect(second.depreciation).toBe(100_200);
		// 期首簿価 = 600,000 − 25,050
		expect(second.openingBookValue).toBe(574_950);
		expect(second.accumulated).toBe(125_250);
	});

	it('残存簿価1円まで償却し、それ以上は償却しない', () => {
		const target = asset();
		// 6年で 100,200×6 = 601,200 > 600,000 なので6年目に打ち切られる
		const sixth = depreciationForYear(target, 2031);
		expect(sixth.closingBookValue).toBe(1);
		expect(sixth.isFinalYear).toBe(true);
		// 6年目の償却費は 600,000 − 100,200×5 − 1 = 98,999
		expect(sixth.depreciation).toBe(98_999);

		// 7年目以降は償却なし、簿価は1円のまま
		const seventh = depreciationForYear(target, 2032);
		expect(seventh.depreciation).toBe(0);
		expect(seventh.closingBookValue).toBe(1);
		expect(seventh.isFinalYear).toBe(false);
	});

	it('累計償却額と期末簿価の合計が取得価額に一致する', () => {
		const target = asset();
		const result = depreciationForYear(target, 2031);
		expect(result.accumulated + result.closingBookValue).toBe(target.acquisitionCost);
	});

	it('取得年より前の年度は償却対象外', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2027-04-01' }), 2026);
		expect(result.depreciation).toBe(0);
		expect(result.months).toBe(0);
	});

	it('除却年は除却月まで月割し、翌年は償却しない', () => {
		const target = asset({ acquiredOn: '2026-01-01', disposedOn: '2027-04-30' });
		const disposalYear = depreciationForYear(target, 2027);
		// 1〜4月の4ヶ月 → 100,200 × 4/12 = 33,400
		expect(disposalYear.months).toBe(4);
		expect(disposalYear.depreciation).toBe(33_400);

		const afterDisposal = depreciationForYear(target, 2028);
		expect(afterDisposal.depreciation).toBe(0);
	});
});

describe('一括償却資産（3年均等）', () => {
	// 取得価額180,000 → 1/3ずつ3年。月割しない。
	it('取得月にかかわらず3年で均等償却する', () => {
		const target = asset({
			acquisitionCost: 180_000,
			method: 'lumpSum3Year',
			account: '一括償却資産',
			acquiredOn: '2026-12-20',
		});

		expect(depreciationForYear(target, 2026).depreciation).toBe(60_000);
		expect(depreciationForYear(target, 2027).depreciation).toBe(60_000);
		expect(depreciationForYear(target, 2028).depreciation).toBe(60_000);
		expect(depreciationForYear(target, 2029).depreciation).toBe(0);
	});

	it('残存簿価を残さず全額償却する', () => {
		const target = asset({ acquisitionCost: 180_000, method: 'lumpSum3Year' });
		expect(depreciationForYear(target, 2028).closingBookValue).toBe(0);
	});

	it('3で割り切れない端数は最終年に寄せる', () => {
		const target = asset({ acquisitionCost: 190_000, method: 'lumpSum3Year' });
		expect(depreciationForYear(target, 2026).depreciation).toBe(63_333);
		expect(depreciationForYear(target, 2027).depreciation).toBe(63_333);
		expect(depreciationForYear(target, 2028).depreciation).toBe(63_334);
		expect(depreciationForYear(target, 2028).closingBookValue).toBe(0);
	});
});

describe('即時償却', () => {
	it('取得年に全額を償却する', () => {
		const target = asset({
			acquisitionCost: 250_000,
			method: 'immediate',
			acquiredOn: '2026-11-01',
		});
		expect(depreciationForYear(target, 2026).depreciation).toBe(250_000);
		expect(depreciationForYear(target, 2026).closingBookValue).toBe(0);
		expect(depreciationForYear(target, 2027).depreciation).toBe(0);
	});
});

describe('事業専用割合の按分', () => {
	it('必要経費算入額を事業専用割合で按分し、残りを家事使用分にする', () => {
		const result = depreciationForYear(asset({ businessUseRatio: 70 }), 2026);
		expect(result.depreciation).toBe(100_200);
		// 100,200 × 70% = 70,140
		expect(result.businessExpense).toBe(70_140);
		expect(result.privatePortion).toBe(30_060);
		expect(result.businessExpense + result.privatePortion).toBe(result.depreciation);
	});
});

describe('depreciationSchedule', () => {
	const assets: FixedAsset[] = [
		asset({ id: 1, name: 'ミシン', acquiredOn: '2026-01-01', acquisitionCost: 600_000, usefulLife: 6 }),
		asset({
			id: 2, name: 'ノートPC', acquiredOn: '2026-07-01', acquisitionCost: 240_000,
			usefulLife: 4, businessUseRatio: 80,
		}),
		asset({ id: 3, name: 'タブレット', acquiredOn: '2026-05-01', acquisitionCost: 180_000, method: 'lumpSum3Year' }),
		asset({ id: 4, name: '来年取得予定の裁断機', acquiredOn: '2027-02-01', acquisitionCost: 500_000 }),
	];

	it('当年度に取得済みの資産だけを取得日順で並べる', () => {
		const schedule = depreciationSchedule(assets, 2026);
		expect(schedule.rows.map((row) => row.asset.id)).toEqual([1, 3, 2]);
	});

	it('合計を集計する', () => {
		const schedule = depreciationSchedule(assets, 2026);
		// ミシン 100,200 ／ タブレット 60,000 ／ PC 240,000×0.25×6/12 = 30,000
		expect(schedule.depreciationTotal).toBe(100_200 + 60_000 + 30_000);
		// PC のみ事業専用割合80% → 30,000×80% = 24,000
		expect(schedule.businessExpenseTotal).toBe(100_200 + 60_000 + 24_000);
	});

	it('期末簿価合計と累計償却額合計の和が取得価額合計に一致する', () => {
		const schedule = depreciationSchedule(assets, 2026);
		const acquiredCost = assets
			.filter((row) => row.acquiredOn < '2027-01-01')
			.reduce((sum, row) => sum + row.acquisitionCost, 0);
		expect(schedule.closingBookValueTotal + schedule.accumulatedTotal).toBe(acquiredCost);
	});
});
