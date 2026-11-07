import { formatPeriodName, validateNewPeriod } from '@/lib/accounting/period';

const sole2026 = { businessType: 'soleProprietor' as const, startsOn: '2026-01-01', endsOn: '2026-12-31' };

describe('FREQ-555-AC-01: 期間の登録は重なりとすき間と1年超と個人の暦年外を断る', () => {
	it('2026年個人の後の 2027-01-01〜2027-06-30 は受理する（やめた年は終わりが早くてよい）', () => {
		expect(
			validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-06-30', existing: [sole2026] }),
		).toEqual({ ok: true });
	});

	it('2027-02-01 始まりは gap、2026-06-01 始まりは overlap', () => {
		expect(
			validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2027-02-01', endsOn: '2027-12-31', existing: [sole2026] }),
		).toEqual({ ok: false, code: 'gap' });
		expect(
			validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2026-06-01', endsOn: '2027-05-31', existing: [sole2026] }),
		).toEqual({ ok: false, code: 'overlap' });
	});

	it('最初の期間の前の日まで終わる期間は受け、1日でも離れれば gap', () => {
		expect(
			validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2025-01-01', endsOn: '2025-12-31', existing: [sole2026] }),
		).toEqual({ ok: true });
		expect(
			validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2024-01-01', endsOn: '2024-12-31', existing: [sole2026] }),
		).toEqual({ ok: false, code: 'gap' });
	});

	it('個人は1月1日始まりでなければ sole_not_calendar', () => {
		expect(validateNewPeriod({ businessType: 'soleProprietor', startsOn: '2026-02-01', endsOn: '2026-12-31', existing: [] })).toEqual({
			ok: false,
			code: 'sole_not_calendar',
		});
	});

	it('法人の 2027-07-01〜2028-07-01 は too_long、第1期の6か月は受理する', () => {
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-07-01', existing: [] })).toEqual({
			ok: false,
			code: 'too_long',
		});
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-06-30', existing: [] })).toEqual({
			ok: true,
		});
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2027-12-31', existing: [sole2026] })).toEqual({
			ok: true,
		});
	});

	it('2028-02-29〜2029-02-28 は受理し、同じ始まりで 2029-03-01 終わりは too_long', () => {
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2028-02-29', endsOn: '2029-02-28', existing: [] })).toEqual({
			ok: true,
		});
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2028-02-29', endsOn: '2029-03-01', existing: [] })).toEqual({
			ok: false,
			code: 'too_long',
		});
	});

	it('始まりが終わりより後なら bad_range、個人と法人は互いに重なってよい', () => {
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2027-07-02', endsOn: '2027-07-01', existing: [] })).toEqual({
			ok: false,
			code: 'bad_range',
		});
		expect(validateNewPeriod({ businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30', existing: [sole2026] })).toEqual({
			ok: true,
		});
	});
});

describe('FREQ-555-AC-01: 期間の名前は個人がYYYY年（個人）で法人が始まり順の第N期になる', () => {
	it('個人は 2026年（個人）、法人は 第1期・第2期', () => {
		expect(formatPeriodName(sole2026)).toBe('2026年（個人）');
		expect(formatPeriodName({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-06-30', termNumber: 1 })).toBe('第1期');
		expect(formatPeriodName({ businessType: 'corporation', startsOn: '2028-07-01', endsOn: '2029-06-30', termNumber: 2 })).toBe('第2期');
	});

	it('法人で期数が無いか1未満なら断る', () => {
		expect(() => formatPeriodName({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-06-30' })).toThrow(RangeError);
		expect(() => formatPeriodName({ businessType: 'corporation', startsOn: '2027-07-01', endsOn: '2028-06-30', termNumber: 0 })).toThrow(
			RangeError,
		);
	});
});
