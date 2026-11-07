import {
	DEPRECIATION_METHOD_LABELS,
	SELECTABLE_DEPRECIATION_METHODS,
	UnsupportedDepreciationMethodError,
	depreciationForYear,
	depreciationSchedule,
	monthsInPeriod,
	usedMonthsInPeriod,
	type DepreciationPeriod,
	type FixedAsset,
} from '@/lib/finance/depreciation';

// 減価償却の月数を会計の期間で数える（FREQ-557-AC-04・設計 11-f・11-f2・11-3）。

function asset(partial: Partial<FixedAsset> = {}): FixedAsset {
	return {
		id: 1,
		name: 'ミシン',
		account: '工具器具備品',
		acquiredOn: '2027-07-01',
		acquisitionCost: 600000,
		usefulLife: 6,
		method: 'straightLine',
		businessUseRatio: 100,
		disposedOn: null,
		memo: '',
		...partial,
	};
}

const corp = (startsOn: string, endsOn: string): DepreciationPeriod => ({ businessType: 'corporation', startsOn, endsOn });
const sole = (startsOn: string, endsOn: string): DepreciationPeriod => ({ businessType: 'soleProprietor', startsOn, endsOn });

// 取得価額600,000／耐用年数6年／償却率0.167 → 1年分 100,200
const FIRST_TERM = corp('2027-07-01', '2027-12-31');

describe('monthsInPeriod（暦で数え、1か月に満たない端数は1か月に切り上げる）', () => {
	const cases: Array<[string, string, number]> = [
		['2027-07-01', '2027-12-31', 6],
		['2027-01-01', '2027-12-31', 12],
		['2027-07-15', '2028-07-14', 12],
		['2027-07-15', '2027-12-31', 6],
		['2027-07-01', '2027-07-10', 1],
		['2027-07-15', '2027-08-10', 1],
		['2027-07-15', '2027-07-15', 1],
		['2028-02-01', '2028-02-29', 1],
		['2027-04-01', '2028-03-31', 12],
	];
	for (const [startsOn, endsOn, months] of cases) {
		it(`FREQ-557-AC-04: ${startsOn}〜${endsOn} は${months}か月`, () => {
			expect(monthsInPeriod(startsOn, endsOn)).toBe(months);
		});
	}

	it('FREQ-557-AC-04: 始まりが終わりより後なら断る', () => {
		expect(() => monthsInPeriod('2027-12-31', '2027-07-01')).toThrow(RangeError);
	});
});

describe('usedMonthsInPeriod（使い始めた日の月から期間の終わりの月まで）', () => {
	it('FREQ-557-AC-04: 月の途中の使い始めは1か月に数える', () => {
		expect(usedMonthsInPeriod('2027-09-10', FIRST_TERM)).toBe(4);
		expect(usedMonthsInPeriod('2027-09-30', FIRST_TERM)).toBe(4);
		expect(usedMonthsInPeriod('2027-12-31', FIRST_TERM)).toBe(1);
	});

	it('FREQ-557-AC-04: 期間より前に使い始めていれば期間の全部の月を数える', () => {
		expect(usedMonthsInPeriod('2020-03-15', FIRST_TERM)).toBe(6);
		expect(usedMonthsInPeriod('2027-07-01', FIRST_TERM)).toBe(6);
	});

	it('FREQ-557-AC-04: 期間の終わりより後の使い始めは0', () => {
		expect(usedMonthsInPeriod('2028-01-01', FIRST_TERM)).toBe(0);
	});

	it('FREQ-557-AC-04: 事業をやめた個人の最後の期間は、やめた日の月まで数える', () => {
		expect(usedMonthsInPeriod('2020-03-15', sole('2027-01-01', '2027-08-31'))).toBe(8);
		expect(usedMonthsInPeriod('2027-03-01', sole('2027-01-01', '2027-08-31'))).toBe(6);
	});
});

describe('FREQ-557-AC-04: 6か月の期間の定額法は償却率に6/12を掛け途中の使い始めは限度額を6で割って使った月数を掛ける', () => {
	it('期首から使う資産は 100,200 × 6/12 = 50,100', () => {
		const result = depreciationForYear(asset(), 2027, FIRST_TERM);
		expect(result.months).toBe(6);
		expect(result.depreciation).toBe(50_100);
		expect(result.openingBookValue).toBe(600_000);
		expect(result.closingBookValue).toBe(549_900);
		expect(result.accumulated).toBe(50_100);
	});

	it('2027-09-10 に使い始めた資産は 50,100 ÷ 6 × 4 = 33,400（9〜12月）', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2027-09-10' }), 2027, FIRST_TERM);
		expect(result.months).toBe(4);
		expect(result.depreciation).toBe(33_400);
		expect(result.closingBookValue).toBe(566_600);
	});

	it('取得日と使い始めた日が違えば使い始めた日で数える', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2027-07-20', serviceStartedOn: '2027-09-10' }), 2027, FIRST_TERM);
		expect(result.depreciation).toBe(33_400);
	});

	it('FREQ-557-AC-04: 月の途中の使い始めは1か月に数える（12月31日の使い始めは 50,100 ÷ 6 × 1 = 8,350）', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2027-12-31' }), 2027, FIRST_TERM);
		expect(result.months).toBe(1);
		expect(result.depreciation).toBe(8_350);
	});

	it('事業専用割合は償却額に掛ける', () => {
		const result = depreciationForYear(asset({ businessUseRatio: 50 }), 2027, FIRST_TERM);
		expect(result.depreciation).toBe(50_100);
		expect(result.businessExpense).toBe(25_050);
		expect(result.privatePortion).toBe(25_050);
	});

	it('期間の途中で除却した資産は除却の月まで数える', () => {
		const result = depreciationForYear(asset({ disposedOn: '2027-10-20' }), 2027, FIRST_TERM);
		expect(result.months).toBe(4);
		expect(result.depreciation).toBe(33_400);
	});

	it('期間の前に使い始めていない資産は0', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2028-01-05' }), 2027, FIRST_TERM);
		expect(result.depreciation).toBe(0);
		expect(result.months).toBe(0);
	});

	it('次の期は前の期の償却を引いた簿価から始まり、12か月なら満額', () => {
		const second = corp('2028-01-01', '2028-12-31');
		const result = depreciationForYear(asset(), 2028, second, [FIRST_TERM]);
		expect(result.openingBookValue).toBe(549_900);
		expect(result.months).toBe(12);
		expect(result.depreciation).toBe(100_200);
		expect(result.accumulated).toBe(150_300);
	});

	it('日の途中から始まる12か月の期間は満額（13か月に数えない）', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2020-01-01' }), 2027, corp('2027-07-15', '2028-07-14'), [
			corp('2026-07-15', '2027-07-14'),
		]);
		expect(result.months).toBe(12);
		expect(result.depreciation).toBe(100_200);
	});

	it('一括償却資産と即時償却は月割せず期の順で数える', () => {
		const second = corp('2028-01-01', '2028-12-31');
		const lump = asset({ method: 'lumpSum3Year', acquisitionCost: 150_000 });
		expect(depreciationForYear(lump, 2027, FIRST_TERM).depreciation).toBe(50_000);
		expect(depreciationForYear(lump, 2028, second, [FIRST_TERM]).depreciation).toBe(50_000);
		const immediate = asset({ method: 'immediate', acquisitionCost: 80_000 });
		expect(depreciationForYear(immediate, 2027, FIRST_TERM).depreciation).toBe(80_000);
		expect(depreciationForYear(immediate, 2028, second, [FIRST_TERM]).depreciation).toBe(0);
	});

	it('残存簿価1円は割らない', () => {
		const result = depreciationForYear(asset({ acquisitionCost: 100, usefulLife: 2 }), 2027, FIRST_TERM);
		expect(result.depreciation).toBe(25);
		const tiny = depreciationForYear(asset({ acquisitionCost: 1 }), 2027, FIRST_TERM);
		expect(tiny.depreciation).toBe(0);
		expect(tiny.closingBookValue).toBe(1);
	});
});

describe('FREQ-557-AC-04: 個人の暦年では従来の償却額と同じ', () => {
	const calendar = (year: number) => sole(`${year}-01-01`, `${year}-12-31`);
	const variants: Array<[string, FixedAsset]> = [
		['期首取得', asset({ acquiredOn: '2026-01-01' })],
		['期の途中の取得', asset({ acquiredOn: '2026-04-15' })],
		['使い始めが取得の後', asset({ acquiredOn: '2026-02-01', serviceStartedOn: '2026-08-31' })],
		['除却あり', asset({ acquiredOn: '2026-01-01', disposedOn: '2028-05-10' })],
		['一括償却', asset({ acquiredOn: '2026-05-01', method: 'lumpSum3Year', acquisitionCost: 150_000 })],
		['即時償却', asset({ acquiredOn: '2026-05-01', method: 'immediate', acquisitionCost: 80_000 })],
		['事業専用割合', asset({ acquiredOn: '2026-03-01', businessUseRatio: 60 })],
	];
	for (const [label, target] of variants) {
		it(`${label}は2025〜2034年の全部が期間なしの値と一致する`, () => {
			for (let year = 2025; year <= 2034; year += 1) {
				expect(depreciationForYear(target, year, calendar(year))).toEqual(depreciationForYear(target, year));
			}
		});
	}

	it('台帳全体の明細も期間なしと一致する', () => {
		const assets = variants.map(([, target], index) => ({ ...target, id: index + 1 }));
		for (let year = 2025; year <= 2034; year += 1) {
			expect(depreciationSchedule(assets, year, calendar(year))).toEqual(depreciationSchedule(assets, year));
		}
	});
});

describe('FREQ-557-AC-04: 事業をやめた年は月数を終わりの月までで割る', () => {
	const lastTerm = sole('2027-01-01', '2027-08-31');

	it('前の年から使う資産は 100,200 ÷ 12 × 8（1〜8月）= 66,800', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2026-01-01' }), 2027, lastTerm);
		expect(result.months).toBe(8);
		expect(result.depreciation).toBe(66_800);
		expect(result.openingBookValue).toBe(499_800);
		expect(result.closingBookValue).toBe(433_000);
	});

	it('やめた年の3月に使い始めた資産は 100,200 ÷ 12 × 6（3〜8月）= 50,100', () => {
		const result = depreciationForYear(asset({ acquiredOn: '2027-03-01' }), 2027, lastTerm);
		expect(result.months).toBe(6);
		expect(result.depreciation).toBe(50_100);
	});

	it('やめた日より後の月に使い始めた資産は0', () => {
		expect(depreciationForYear(asset({ acquiredOn: '2027-09-01' }), 2027, lastTerm).depreciation).toBe(0);
	});

	it('台帳全体の明細もやめた月までで数える', () => {
		const schedule = depreciationSchedule(
			[asset({ id: 1, acquiredOn: '2026-01-01' }), asset({ id: 2, acquiredOn: '2027-09-01' })],
			2027,
			lastTerm,
		);
		expect(schedule.rows.map((row) => row.asset.id)).toEqual([1]);
		expect(schedule.depreciationTotal).toBe(66_800);
	});
});

describe('FREQ-557-AC-04: 法人で定率法の指定は未対応として明示的に拒否する', () => {
	const declining = asset({ method: 'decliningBalance' });

	it('法人の期間で渡すと UnsupportedDepreciationMethodError を投げる（定額法にしない）', () => {
		expect(() => depreciationForYear(declining, 2027, FIRST_TERM)).toThrow(UnsupportedDepreciationMethodError);
	});

	it('個人の期間も従来の3つの値だけを受ける', () => {
		expect(() => depreciationForYear(declining, 2027, sole('2027-01-01', '2027-12-31'))).toThrow(UnsupportedDepreciationMethodError);
	});

	it('期間なしの呼び出しも黙って定額法にしない', () => {
		expect(() => depreciationForYear(declining, 2027)).toThrow(UnsupportedDepreciationMethodError);
	});

	it('台帳の明細も同じく拒否する', () => {
		expect(() => depreciationSchedule([declining], 2027, FIRST_TERM)).toThrow(UnsupportedDepreciationMethodError);
	});
});

describe('FREQ-557-AC-04: 定率法は画面の選択肢に出さない', () => {
	it('選べる償却方法は定額法・一括償却・即時償却の3つだけ', () => {
		expect([...SELECTABLE_DEPRECIATION_METHODS]).toEqual(['straightLine', 'lumpSum3Year', 'immediate']);
		const labels = SELECTABLE_DEPRECIATION_METHODS.map((method) => DEPRECIATION_METHOD_LABELS[method]);
		expect(labels).toEqual(['定額法', '一括償却（3年均等）', '即時償却']);
		expect(labels.join()).not.toContain('定率法');
		expect(SELECTABLE_DEPRECIATION_METHODS).not.toContain('decliningBalance');
	});

	it('定率法の名前は表示用に持つ（台帳に出る場合の読み方）', () => {
		expect(DEPRECIATION_METHOD_LABELS.decliningBalance).toBe('定率法');
	});
});
