// 期間ごとの申告の期限（設計 11-h・5-j・15-c2。I/O なし）。

import { addDays, monthsPeriodEnd, parseIsoDate, weekdayOf, type AccountingPeriod } from '@/lib/accounting/period';

export type FilingDeadline = {
	tax: 'income_tax' | 'consumption_tax_individual' | 'corporate_tax' | 'consumption_tax_corporate' | 'local_tax';
	baseDue: string;
	due: string;
	rolled: boolean;
	extended: boolean;
	holidayTableMissing: boolean;
	note: string;
};

export type InterimFiling = {
	tax: 'corporate_tax' | 'consumption_tax_corporate';
	required: boolean | null;
	reason: 'first_term' | 'prior_tax_unknown';
	dueOn: string | null;
};

export type HolidayLookup = (date: string) => boolean | undefined;

/** 法人税の延長（法人税法75条の2）。延ばした分に利子税がかかる。 */
const EXTENSION_NOTE = '延ばした分に利子税がかかる';
/**
 * 地方税の延長。法人税の延長とは扱いが違う（利子税ではない）。
 * - 事業税・特別法人事業税: 延長は都道府県知事の承認を受ける（地方税法72条の25第3項）。
 *   延ばした分には延滞金がかかる（同72条の45の2）。
 * - 法人住民税（法人税割）: 法人税の申告書の提出期限に合わせて延び、要るのは届出（同53条）。
 * 2026-11-07 に e-Gov の法令 API v1 で条文を確かめた。v1 は古い版を返すことがあるため、
 * 開店前に税理士に今の版で確かめてもらう（台帳の未確認事項）。
 */
const LOCAL_TAX_EXTENSION_NOTE = [
	'事業税・特別法人事業税は都道府県知事の承認が別に要る',
	'延ばした分に延滞金がかかる',
	'住民税は法人税の延長に合わせて延び、届け出が要る',
].join('。');

/**
 * 期限が土曜・日曜・祝日・1月2日・3日・12月29日〜31日に当たれば次の日にする（国税通則法10条2項・同施行令2条2項）。
 * 1月2日・3日は「一般の休日」に当たる（国税通則法基本通達 第10条関係 4・5、
 * https://www.nta.go.jp/law/tsutatsu/kihon/tsusoku/01/03/10.htm ）。
 * 祝日の表が無い年に当たって確かめられないときは、元の日に `holidayTableMissing=true` を付けて返す。
 */
export function rollForwardDeadline(
	baseDue: string,
	isHoliday: HolidayLookup,
): { due: string; rolled: boolean; holidayTableMissing: boolean } {
	let due = baseDue;
	for (;;) {
		const { month, day } = parseIsoDate(due);
		const weekday = weekdayOf(due);
		const closed =
			weekday === 0 || weekday === 6 || (month === 1 && (day === 2 || day === 3)) || (month === 12 && day >= 29);
		if (!closed) {
			const holiday = isHoliday(due);
			if (holiday === undefined) return { due: baseDue, rolled: false, holidayTableMissing: true };
			if (!holiday) return { due, rolled: due !== baseDue, holidayTableMissing: false };
		}
		due = addDays(due, 1);
	}
}

function deadline(
	tax: FilingDeadline['tax'],
	baseDue: string,
	extended: boolean,
	note: string,
	isHoliday: HolidayLookup,
): FilingDeadline {
	const { due, rolled, holidayTableMissing } = rollForwardDeadline(baseDue, isHoliday);
	return { tax, baseDue, due, rolled, extended, holidayTableMissing, note };
}

/** 課税の期間の注記。課税でない期間は null（消費税の期限を出さない）。 */
function consumptionTaxNote(period: AccountingPeriod): string | null {
	if (period.consumptionTaxStatus !== 'taxable') return null;
	const from = period.consumptionTaxableFrom;
	if (from === null || from <= period.startsOn) return '';
	if (from > period.endsOn) return null;
	return `${from}から${period.endsOn}までが課税の期間`;
}

function joinNotes(...notes: string[]): string {
	return notes.filter((n) => n !== '').join('。');
}

/** 第N期の N。名前から読めなければ null。 */
function termNumberOf(period: AccountingPeriod): number | null {
	const matched = /^第(\d+)期$/.exec(period.name);
	return matched ? Number(matched[1]) : null;
}

export function filingDeadlines(
	period: AccountingPeriod,
	isHoliday: HolidayLookup,
): { deadlines: FilingDeadline[]; interim: InterimFiling[] } {
	const consumptionNote = consumptionTaxNote(period);
	const deadlines: FilingDeadline[] = [];
	const interim: InterimFiling[] = [];

	if (period.businessType === 'soleProprietor') {
		const nextYear = parseIsoDate(period.endsOn).year + 1;
		deadlines.push(deadline('income_tax', `${nextYear}-03-15`, false, '', isHoliday));
		if (consumptionNote !== null) {
			deadlines.push(deadline('consumption_tax_individual', `${nextYear}-03-31`, false, consumptionNote, isHoliday));
		}
		return { deadlines, interim };
	}

	// 法人税は終了の日の翌日から2か月（延長は月を足す）。地方税も同じ日。
	const corporateExtended = period.corporateTaxExtensionMonths === 1;
	const corporateBase = monthsPeriodEnd(period.endsOn, 2 + period.corporateTaxExtensionMonths);
	const corporateNote = corporateExtended ? EXTENSION_NOTE : '';
	deadlines.push(deadline('corporate_tax', corporateBase, corporateExtended, corporateNote, isHoliday));
	deadlines.push(
		deadline(
			'local_tax',
			corporateBase,
			corporateExtended,
			corporateExtended ? LOCAL_TAX_EXTENSION_NOTE : '',
			isHoliday,
		),
	);
	if (consumptionNote !== null) {
		// 消費税の延長は法人税の延長を受けた法人だけ（消費税法45条の2）。
		const consumptionExtended = corporateExtended && period.consumptionTaxExtensionMonths === 1;
		const consumptionBase = monthsPeriodEnd(period.endsOn, consumptionExtended ? 3 : 2);
		deadlines.push(
			deadline(
				'consumption_tax_corporate',
				consumptionBase,
				consumptionExtended,
				joinNotes(consumptionNote, consumptionExtended ? EXTENSION_NOTE : ''),
				isHoliday,
			),
		);
	}

	// 中間申告: 期首から6か月を過ぎた日から2か月以内。第1期は前の期が無いので不要。
	const interimTaxes: InterimFiling['tax'][] = consumptionNote === null ? ['corporate_tax'] : ['corporate_tax', 'consumption_tax_corporate'];
	if (termNumberOf(period) === 1) {
		for (const tax of interimTaxes) interim.push({ tax, required: false, reason: 'first_term', dueOn: null });
	} else {
		const sixMonthsEnd = monthsPeriodEnd(addDays(period.startsOn, -1), 6);
		const dueOn = rollForwardDeadline(monthsPeriodEnd(sixMonthsEnd, 2), isHoliday).due;
		for (const tax of interimTaxes) interim.push({ tax, required: null, reason: 'prior_tax_unknown', dueOn });
	}
	return { deadlines, interim };
}
