import { filingDeadlines } from '@/lib/accounting/filing-deadlines';
import { isJpHoliday } from '@/lib/accounting/jp-holidays';
import type { AccountingPeriod } from '@/lib/accounting/period';

function period(overrides: Partial<AccountingPeriod>): AccountingPeriod {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		businessType: 'corporation',
		name: '第1期',
		startsOn: '2027-07-01',
		endsOn: '2028-06-30',
		corporateTaxExtensionMonths: 0,
		consumptionTaxExtensionMonths: 0,
		consumptionTaxStatus: 'exempt',
		consumptionTaxableFrom: null,
		version: '1',
		...overrides,
	};
}

/** 2028年以後も確かめられるよう、試験の中だけで祝日を与える。 */
function holidays(...dates: string[]): (date: string) => boolean {
	const set = new Set(dates);
	return (date) => set.has(date);
}

describe('FREQ-561-AC-01: 令和7年分の所得税の期限は2026-03-16に繰り下がる', () => {
	it('個人の2025年の期間は翌年3月15日（日曜）から次の日の月曜にする', () => {
		const result = filingDeadlines(
			period({ businessType: 'soleProprietor', name: '2025年（個人）', startsOn: '2025-01-01', endsOn: '2025-12-31' }),
			isJpHoliday,
		);
		expect(result.deadlines).toEqual([
			{
				tax: 'income_tax',
				baseDue: '2026-03-15',
				due: '2026-03-16',
				rolled: true,
				extended: false,
				holidayTableMissing: false,
				note: '',
			},
		]);
		expect(result.interim).toEqual([]);
	});
});

describe('FREQ-561-AC-01: 法人の期限は終了日の翌日から2か月で休みの日は次の日にし延長の月を足す', () => {
	it('2028-06-30 終わりは 2028-08-31（木曜）で繰り下げなし、地方税も同じ日', () => {
		const { deadlines } = filingDeadlines(period({}), holidays());
		expect(deadlines.map((d) => [d.tax, d.baseDue, d.due, d.rolled])).toEqual([
			['corporate_tax', '2028-08-31', '2028-08-31', false],
			['local_tax', '2028-08-31', '2028-08-31', false],
		]);
	});

	it('12月末の決算は 2028-02-29', () => {
		const { deadlines } = filingDeadlines(period({ startsOn: '2027-07-01', endsOn: '2027-12-31' }), holidays());
		expect(deadlines[0]).toMatchObject({ tax: 'corporate_tax', baseDue: '2028-02-29', due: '2028-02-29', rolled: false, extended: false });
	});

	it('延長1か月は 2028-03-31 を基準に繰り下げを判定し、利子税の note を付ける', () => {
		const { deadlines } = filingDeadlines(
			period({ startsOn: '2027-07-01', endsOn: '2027-12-31', corporateTaxExtensionMonths: 1 }),
			holidays(),
		);
		expect(deadlines[0]).toEqual({
			tax: 'corporate_tax',
			baseDue: '2028-03-31',
			due: '2028-03-31',
			rolled: false,
			extended: true,
			holidayTableMissing: false,
			note: '延ばした分に利子税がかかる',
		});
	});

	it('延長した地方税は都道府県・市町村への申請が別に要ると note に書く', () => {
		const { deadlines } = filingDeadlines(
			period({ startsOn: '2027-07-01', endsOn: '2027-12-31', corporateTaxExtensionMonths: 1 }),
			holidays(),
		);
		expect(deadlines[1]).toMatchObject({
			tax: 'local_tax',
			due: '2028-03-31',
			extended: true,
			note: '延ばした分に利子税がかかる。都道府県・市町村への申請が別に要る',
		});
	});
});

describe('FREQ-561-AC-01: 12月29日から31日と祝日は次の日にする', () => {
	it('2027-12-31 の期限は年末・元日・日曜・1月3日を越えて 2028-01-04 になる', () => {
		const { deadlines } = filingDeadlines(
			period({ startsOn: '2026-11-01', endsOn: '2027-10-31' }),
			holidays('2028-01-01'),
		);
		expect(deadlines[0]).toMatchObject({ baseDue: '2027-12-31', due: '2028-01-04', rolled: true });
	});

	it('文化の日（2026-11-03）に当たる期限は 2026-11-04 になる', () => {
		const { deadlines } = filingDeadlines(period({ startsOn: '2025-09-04', endsOn: '2026-09-03' }), isJpHoliday);
		expect(deadlines[0]).toMatchObject({ baseDue: '2026-11-03', due: '2026-11-04', rolled: true, holidayTableMissing: false });
	});
});

describe('FREQ-561-AC-01: 1月2日と3日は一般の休日として次の日にする', () => {
	it('2026-01-02（金曜）の期限は1月3日・土日を越えて 2026-01-05 になる', () => {
		const { deadlines } = filingDeadlines(period({ startsOn: '2024-11-03', endsOn: '2025-11-02' }), isJpHoliday);
		expect(deadlines[0]).toMatchObject({ baseDue: '2026-01-02', due: '2026-01-05', rolled: true, holidayTableMissing: false });
	});

	it('2025-12-31（水曜）の期限は年末・元日・1月2日・3日・日曜を越えて 2026-01-05 になる', () => {
		const { deadlines } = filingDeadlines(period({ startsOn: '2024-11-01', endsOn: '2025-10-31' }), isJpHoliday);
		expect(deadlines[0]).toMatchObject({ baseDue: '2025-12-31', due: '2026-01-05', rolled: true });
	});
});

describe('FREQ-561-AC-01: 祝日の表の無い年の期限は元の日にholidayTableMissingを付ける', () => {
	it('2028年は表が無いので 2028-08-31 のまま holidayTableMissing=true', () => {
		expect(isJpHoliday('2028-08-31')).toBeUndefined();
		const { deadlines } = filingDeadlines(period({}), isJpHoliday);
		expect(deadlines[0]).toMatchObject({ baseDue: '2028-08-31', due: '2028-08-31', rolled: false, holidayTableMissing: true });
	});
});

describe('FREQ-561-AC-01: 第1期の中間申告は不要、第2期以後は判定できないと返す', () => {
	it('第1期は required=false・first_term', () => {
		expect(filingDeadlines(period({}), holidays()).interim).toEqual([
			{ tax: 'corporate_tax', required: false, reason: 'first_term', dueOn: null },
		]);
	});

	it('第2期は required=null・prior_tax_unknown で、6か月を過ぎた日から2か月の期限を返す', () => {
		const { interim } = filingDeadlines(
			period({ name: '第2期', startsOn: '2028-07-01', endsOn: '2029-06-30' }),
			holidays(),
		);
		expect(interim).toEqual([{ tax: 'corporate_tax', required: null, reason: 'prior_tax_unknown', dueOn: '2029-02-28' }]);
	});
});

describe('FREQ-561-AC-01: 消費税の期限は期間がexemptなら返さず、taxableなら課税の期間だけ返し、年の途中の課税事業者になった日をnoteに書く', () => {
	it('exempt の期間は消費税を返さない', () => {
		const { deadlines } = filingDeadlines(period({}), holidays());
		expect(deadlines.some((d) => d.tax === 'consumption_tax_corporate')).toBe(false);
	});

	it('個人の taxable の期間は翌年3月31日', () => {
		const { deadlines } = filingDeadlines(
			period({
				businessType: 'soleProprietor',
				name: '2026年（個人）',
				startsOn: '2026-01-01',
				endsOn: '2026-12-31',
				consumptionTaxStatus: 'taxable',
			}),
			isJpHoliday,
		);
		expect(deadlines.map((d) => [d.tax, d.due, d.note])).toEqual([
			['income_tax', '2027-03-15', ''],
			['consumption_tax_individual', '2027-03-31', ''],
		]);
	});

	it('法人の taxable は法人税と同じ日で、延長は法人税を延ばした時だけ足す', () => {
		const base = { startsOn: '2027-07-01', endsOn: '2027-12-31', consumptionTaxStatus: 'taxable' as const };
		const plain = filingDeadlines(period(base), holidays()).deadlines.find((d) => d.tax === 'consumption_tax_corporate');
		expect(plain).toMatchObject({ due: '2028-02-29', extended: false });
		const extended = filingDeadlines(
			period({ ...base, corporateTaxExtensionMonths: 1, consumptionTaxExtensionMonths: 1 }),
			holidays(),
		).deadlines.find((d) => d.tax === 'consumption_tax_corporate');
		expect(extended).toMatchObject({ baseDue: '2028-03-31', due: '2028-03-31', extended: true, note: '延ばした分に利子税がかかる' });
		const notCorporateExtended = filingDeadlines(
			period({ ...base, corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 1 }),
			holidays(),
		).deadlines.find((d) => d.tax === 'consumption_tax_corporate');
		expect(notCorporateExtended).toMatchObject({ due: '2028-02-29', extended: false });
	});

	it('期間の途中で課税事業者になった日を note に書き、終わりより後なら返さない', () => {
		const mid = filingDeadlines(
			period({ startsOn: '2027-07-01', endsOn: '2028-06-30', consumptionTaxStatus: 'taxable', consumptionTaxableFrom: '2028-01-01' }),
			holidays(),
		).deadlines.find((d) => d.tax === 'consumption_tax_corporate');
		expect(mid?.note).toBe('2028-01-01から2028-06-30までが課税の期間');
		const after = filingDeadlines(
			period({ startsOn: '2027-07-01', endsOn: '2028-06-30', consumptionTaxStatus: 'taxable', consumptionTaxableFrom: '2028-07-01' }),
			holidays(),
		).deadlines;
		expect(after.some((d) => d.tax === 'consumption_tax_corporate')).toBe(false);
	});
});
