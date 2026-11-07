import { splitPeriodByMonth, type PeriodMonthSlice } from '@/lib/accounting/period-months';

/** 日ごとの額を月の区切りで足す（試験の中だけの集計）。 */
function sumByMonth(slices: readonly PeriodMonthSlice[], daily: ReadonlyArray<{ date: string; amount: number }>): Map<string, number> {
	const totals = new Map<string, number>();
	for (const slice of slices) totals.set(slice.key, 0);
	for (const row of daily) {
		const slice = slices.find((s) => s.startsOn <= row.date && row.date <= s.endsOn);
		if (slice) totals.set(slice.key, (totals.get(slice.key) ?? 0) + row.amount);
	}
	return totals;
}

describe('FREQ-555-AC-05: 月ごとの区切りは暦の月で期間の端を切り足すと合計に合う', () => {
	it('2027-07-15〜2028-07-14 は最初と最後の月を期間の端で切り partial にする', () => {
		const slices = splitPeriodByMonth('2027-07-15', '2028-07-14');
		expect(slices).toHaveLength(13);
		expect(slices[0]).toEqual({ key: '2027-07', startsOn: '2027-07-15', endsOn: '2027-07-31', partial: true });
		expect(slices[1]).toEqual({ key: '2027-08', startsOn: '2027-08-01', endsOn: '2027-08-31', partial: false });
		expect(slices[7]).toEqual({ key: '2028-02', startsOn: '2028-02-01', endsOn: '2028-02-29', partial: false });
		expect(slices[12]).toEqual({ key: '2028-07', startsOn: '2028-07-01', endsOn: '2028-07-14', partial: true });
	});

	it('暦年の期間は12か月で partial が無い', () => {
		const slices = splitPeriodByMonth('2026-01-01', '2026-12-31');
		expect(slices.map((s) => s.key)).toEqual([
			'2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
			'2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
		]);
		expect(slices.every((s) => !s.partial)).toBe(true);
	});

	it('1か月の中に収まる期間は1つの partial になる', () => {
		expect(splitPeriodByMonth('2027-03-10', '2027-03-20')).toEqual([
			{ key: '2027-03', startsOn: '2027-03-10', endsOn: '2027-03-20', partial: true },
		]);
	});

	it('月ごとの額を足すと期間の合計に合う', () => {
		const daily = [
			{ date: '2027-07-15', amount: 1000 },
			{ date: '2027-07-31', amount: 250 },
			{ date: '2027-08-01', amount: 3000 },
			{ date: '2028-02-29', amount: 777 },
			{ date: '2028-07-14', amount: 42 },
		];
		const totals = sumByMonth(splitPeriodByMonth('2027-07-15', '2028-07-14'), daily);
		const sum = [...totals.values()].reduce((a, b) => a + b, 0);
		expect(sum).toBe(daily.reduce((a, b) => a + b.amount, 0));
		expect(totals.get('2027-07')).toBe(1250);
		expect(totals.get('2028-02')).toBe(777);
	});

	it('始まりが終わりより後なら断る', () => {
		expect(() => splitPeriodByMonth('2027-07-02', '2027-07-01')).toThrow(RangeError);
	});
});
