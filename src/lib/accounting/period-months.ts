// 期間を暦の月で区切る（設計 11-e2。I/O なし）。

import { addDays, daysInMonth, formatIsoDate, parseIsoDate } from '@/lib/accounting/period';

export type PeriodMonthSlice = {
	/** `YYYY-MM`。 */
	key: string;
	startsOn: string;
	endsOn: string;
	/** 期間の端で切られ、1か月に満たない月。 */
	partial: boolean;
};

/** 期間を暦の月ごとに区切る。最初と最後の月は期間の端で切り、1か月に満たない月に `partial=true` を付ける。 */
export function splitPeriodByMonth(startsOn: string, endsOn: string): PeriodMonthSlice[] {
	parseIsoDate(startsOn);
	parseIsoDate(endsOn);
	if (startsOn > endsOn) throw new RangeError('startsOn must not be after endsOn');

	const slices: PeriodMonthSlice[] = [];
	let cursor = startsOn;
	while (cursor <= endsOn) {
		const { year, month } = parseIsoDate(cursor);
		const monthStart = formatIsoDate(year, month, 1);
		const monthEnd = formatIsoDate(year, month, daysInMonth(year, month));
		const sliceEnd = monthEnd < endsOn ? monthEnd : endsOn;
		slices.push({
			key: monthStart.slice(0, 7),
			startsOn: cursor,
			endsOn: sliceEnd,
			partial: cursor !== monthStart || sliceEnd !== monthEnd,
		});
		cursor = addDays(monthEnd, 1);
	}
	return slices;
}
