import { toJstDate } from '@/lib/accounting/jst-date';

describe('FREQ-554-AC-05: 日本時間の日付へ直す', () => {
	it('UTC の 15:00 以降は日本時間の翌日になる', () => {
		expect(toJstDate('2026-12-31T15:30:00Z')).toBe('2027-01-01');
		expect(toJstDate('2026-12-31T15:00:00Z')).toBe('2027-01-01');
	});

	it('UTC の 14:59:59 までは同じ日のまま', () => {
		expect(toJstDate('2026-12-31T14:59:59Z')).toBe('2026-12-31');
	});

	it('Date と文字列の両方を受ける', () => {
		expect(toJstDate(new Date('2026-12-31T15:30:00Z'))).toBe('2027-01-01');
		expect(toJstDate(new Date('2026-12-31T14:59:59Z'))).toBe('2026-12-31');
		expect(toJstDate('2026-08-15T00:00:00.000+09:00')).toBe('2026-08-15');
	});

	it('読めない日時は断る', () => {
		expect(() => toJstDate('not-a-date')).toThrow(RangeError);
		expect(() => toJstDate(new Date(Number.NaN))).toThrow(RangeError);
	});
});
