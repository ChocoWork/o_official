import { isJpHoliday } from '@/lib/accounting/jp-holidays';
import { startupDeadlines, type StartupDeadline } from '@/lib/accounting/startup-deadlines';

function byKind(list: readonly StartupDeadline[], kind: StartupDeadline['kind']): StartupDeadline | undefined {
	return list.find((d) => d.kind === kind);
}

describe('FREQ-561-AC-02: 開業日の期限は2025年開業なら棚卸資産の評価方法の届け出が過ぎたと最終仕入原価法を示す', () => {
	it('2025-06-01 開業は 2026-03-16 が過ぎ、最終仕入原価法になると示す', () => {
		const list = startupDeadlines('2025-06-01', '2026-11-07', isJpHoliday);
		expect(byKind(list, 'inventory_method_notice')).toEqual({
			kind: 'inventory_method_notice',
			dueOn: '2026-03-16',
			passed: true,
			consequence: '最終仕入原価法（所得税法施行令102条1項）になる',
		});
		expect(byKind(list, 'inventory_method_change')).toEqual({
			kind: 'inventory_method_change',
			dueOn: '2027-03-15',
			passed: false,
			consequence: null,
		});
		expect(list.map((d) => d.kind)).toEqual([
			'business_start_notice',
			'blue_return_approval',
			'inventory_method_notice',
			'inventory_method_change',
		]);
	});

	it('期限の日のうちは過ぎていない', () => {
		const list = startupDeadlines('2025-06-01', '2026-03-16', isJpHoliday);
		expect(byKind(list, 'inventory_method_notice')).toMatchObject({ passed: false, consequence: null });
	});
});

describe('FREQ-561-AC-02: 青色申告の承認の期限は1月15日までと16日以後で変わる', () => {
	it('1月15日の開業はその年の3月15日、1月16日の開業は開業日から2か月', () => {
		expect(byKind(startupDeadlines('2027-01-15', '2027-01-20', isJpHoliday), 'blue_return_approval')?.dueOn).toBe('2027-03-15');
		expect(byKind(startupDeadlines('2027-01-16', '2027-01-20', isJpHoliday), 'blue_return_approval')?.dueOn).toBe('2027-03-16');
		expect(byKind(startupDeadlines('2025-06-01', '2026-11-07', isJpHoliday), 'blue_return_approval')).toMatchObject({
			dueOn: '2025-08-01',
			passed: true,
		});
	});
});

describe('FREQ-561-AC-02: 開業の届けの期限は、2025年の開業なら開業日から1か月、2026年の開業なら年分の確定申告の期限になる', () => {
	it('2025-06-01 開業は 2025-07-01', () => {
		expect(byKind(startupDeadlines('2025-06-01', '2026-11-07', isJpHoliday), 'business_start_notice')).toMatchObject({
			dueOn: '2025-07-01',
			passed: true,
		});
	});

	it('翌月に同じ日が無ければ月末にする（2025-01-31 開業は 2025-02-28）', () => {
		expect(byKind(startupDeadlines('2025-01-31', '2025-02-01', isJpHoliday), 'business_start_notice')?.dueOn).toBe('2025-02-28');
	});

	it('2026-04-01 開業は 2027-03-15（翌年の確定申告の期限）', () => {
		expect(byKind(startupDeadlines('2026-04-01', '2026-11-07', isJpHoliday), 'business_start_notice')).toMatchObject({
			dueOn: '2027-03-15',
			passed: false,
		});
	});
});
