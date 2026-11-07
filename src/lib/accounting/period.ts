// 会計の期間の型・登録の検査・名前と、期間の計算に使う日付の関数（I/O なし）。
// 日付は `YYYY-MM-DD`。`Date` の UTC 部分だけで計算し、実行環境のタイムゾーンに依存しない。

export type AccountingPeriod = {
	id: string;
	businessType: 'soleProprietor' | 'corporation';
	name: string;
	startsOn: string;
	endsOn: string;
	corporateTaxExtensionMonths: 0 | 1;
	consumptionTaxExtensionMonths: 0 | 1;
	consumptionTaxStatus: 'exempt' | 'taxable';
	consumptionTaxableFrom: string | null;
	/** bigint の10進文字列。 */
	version: string;
};

export const MAX_PERIOD_NAME_LENGTH = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

type DateParts = { year: number; month: number; day: number };

/** `YYYY-MM-DD` を年・月・日へ分ける。暦に無い日は断る。 */
export function parseIsoDate(date: string): DateParts {
	const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!matched) throw new RangeError(`invalid date: ${date}`);
	const parts = { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) };
	if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) {
		throw new RangeError(`invalid date: ${date}`);
	}
	return parts;
}

export function formatIsoDate(year: number, month: number, day: number): string {
	return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
	const { year, month, day } = parseIsoDate(date);
	return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 曜日（0=日曜〜6=土曜）。 */
export function weekdayOf(date: string): number {
	const { year, month, day } = parseIsoDate(date);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 年・月を足し、足した先に同じ日が無ければ月末へ丸める（PostgreSQL の `+ interval` と同じ）。 */
export function addMonthsClamped(date: string, months: number): string {
	const { year, month, day } = parseIsoDate(date);
	const index = year * 12 + (month - 1) + months;
	const targetYear = Math.floor(index / 12);
	const targetMonth = (index % 12) + 1;
	return formatIsoDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/**
 * 出来事の日から「N か月以内」の期間が満了する日（国税通則法10条1項）。
 * 初日を数えず翌日から起算し、N か月後の起算日に応当する日の前日に満了する。応当する日が無ければその月の末日。
 * 例: `2028-06-30` から2か月は `2028-08-31`、`2027-12-31` から2か月は `2028-02-29`。
 */
export function monthsPeriodEnd(eventDate: string, months: number): string {
	const start = parseIsoDate(addDays(eventDate, 1));
	const index = start.year * 12 + (start.month - 1) + months;
	const targetYear = Math.floor(index / 12);
	const targetMonth = (index % 12) + 1;
	const lastDay = daysInMonth(targetYear, targetMonth);
	if (start.day > lastDay) return formatIsoDate(targetYear, targetMonth, lastDay);
	return addDays(formatIsoDate(targetYear, targetMonth, start.day), -1);
}

type PeriodRange = Pick<AccountingPeriod, 'businessType' | 'startsOn' | 'endsOn'>;

export type ValidateNewPeriodResult =
	| { ok: true }
	| { ok: false; code: 'overlap' | 'gap' | 'too_long' | 'bad_range' | 'sole_not_calendar' };

/**
 * 新しい期間を登録してよいか確かめる（設計 11-a〜11-d・11-c2）。
 * 長さは `ends_on < starts_on + interval '1 year'`、ただし2月29日始まりは翌年2月28日まで受ける（DB と同じ境界）。
 * 重なり・すき間は同じ事業の形の既存の期間とだけ比べる。
 */
export function validateNewPeriod(input: {
	businessType: AccountingPeriod['businessType'];
	startsOn: string;
	endsOn: string;
	existing: readonly PeriodRange[];
}): ValidateNewPeriodResult {
	const { businessType, startsOn, endsOn } = input;
	try {
		parseIsoDate(startsOn);
		parseIsoDate(endsOn);
	} catch {
		return { ok: false, code: 'bad_range' };
	}
	if (startsOn > endsOn) return { ok: false, code: 'bad_range' };

	const oneYearLater = addMonthsClamped(startsOn, 12);
	const start = parseIsoDate(startsOn);
	const leapDayStart = start.month === 2 && start.day === 29;
	if (!(endsOn < oneYearLater || (leapDayStart && endsOn === oneYearLater))) return { ok: false, code: 'too_long' };

	const sameType = input.existing.filter((p) => p.businessType === businessType);
	if (sameType.some((p) => p.startsOn <= endsOn && startsOn <= p.endsOn)) return { ok: false, code: 'overlap' };
	if (sameType.length > 0) {
		const firstStart = sameType.reduce((min, p) => (p.startsOn < min ? p.startsOn : min), sameType[0].startsOn);
		const lastEnd = sameType.reduce((max, p) => (p.endsOn > max ? p.endsOn : max), sameType[0].endsOn);
		if (startsOn !== addDays(lastEnd, 1) && endsOn !== addDays(firstStart, -1)) return { ok: false, code: 'gap' };
	}

	if (businessType === 'soleProprietor') {
		const end = parseIsoDate(endsOn);
		if (start.month !== 1 || start.day !== 1 || end.year !== start.year) return { ok: false, code: 'sole_not_calendar' };
	}
	return { ok: true };
}

/** 期間の名前。個人は `2026年（個人）`、法人は同じ事業の形の中の始まり順で `第1期`（SQL の名前と同じ文字列）。 */
export function formatPeriodName(p: {
	businessType: AccountingPeriod['businessType'];
	startsOn: string;
	endsOn: string;
	termNumber?: number;
}): string {
	if (p.businessType === 'soleProprietor') return `${parseIsoDate(p.startsOn).year}年（個人）`;
	if (p.termNumber === undefined || !Number.isSafeInteger(p.termNumber) || p.termNumber < 1) {
		throw new RangeError('corporation period needs termNumber >= 1');
	}
	return `第${p.termNumber}期`;
}
