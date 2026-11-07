// 開業日から出す届け出・申請の期限（設計 11-k2。I/O なし）。

import { rollForwardDeadline, type HolidayLookup } from '@/lib/accounting/filing-deadlines';
import { monthsPeriodEnd, parseIsoDate } from '@/lib/accounting/period';

export type StartupDeadline = {
	kind: 'business_start_notice' | 'blue_return_approval' | 'inventory_method_notice' | 'inventory_method_change';
	dueOn: string;
	passed: boolean;
	consequence: string | null;
};

/**
 * 開業の届け（所得税法229条）の期限の出し分け。開業した日に適用される法令で決める。
 * 出典: 令和5年法律第3号 附則1条6号・10条（2026-01-01 施行。それより前の開業は前の229条のまま）。
 */
export const STARTUP_NOTICE_RULES = [
	{ appliesFrom: null, appliesBefore: '2026-01-01', rule: 'one_month_after_start' },
	{ appliesFrom: '2026-01-01', appliesBefore: null, rule: 'annual_return_due' },
] as const;

const INVENTORY_DEFAULT_CONSEQUENCE = '最終仕入原価法（所得税法施行令102条1項）になる';

function noticeRule(businessStartDate: string): (typeof STARTUP_NOTICE_RULES)[number]['rule'] {
	const found = STARTUP_NOTICE_RULES.find(
		(r) => (r.appliesFrom === null || r.appliesFrom <= businessStartDate) && (r.appliesBefore === null || businessStartDate < r.appliesBefore),
	);
	if (!found) throw new RangeError(`no startup notice rule for ${businessStartDate}`);
	return found.rule;
}

export function startupDeadlines(businessStartDate: string, today: string, isHoliday: HolidayLookup): StartupDeadline[] {
	const start = parseIsoDate(businessStartDate);
	parseIsoDate(today);
	const due = (base: string): string => rollForwardDeadline(base, isHoliday).due;

	// 開業した年分の確定申告の期限（翌年3月15日を休みの日の規則で繰り下げた日）。
	const annualReturnDue = due(`${start.year + 1}-03-15`);

	const businessStartNotice =
		noticeRule(businessStartDate) === 'one_month_after_start' ? due(monthsPeriodEnd(businessStartDate, 1)) : annualReturnDue;

	// 青色申告の承認の申請（所得税法144条）: 1月15日以前の開業はその年の3月15日、1月16日以後は開業日から2か月以内。
	const blueReturnBase =
		start.month === 1 && start.day <= 15 ? `${start.year}-03-15` : monthsPeriodEnd(businessStartDate, 2);

	// 棚卸資産の評価の方法の変更の承認の申請（所得税法施行令101条2項）: 変えたい年の3月15日。today の翌年分を示す。
	const inventoryChangeDue = due(`${parseIsoDate(today).year + 1}-03-15`);

	const make = (kind: StartupDeadline['kind'], dueOn: string, consequenceIfPassed: string | null): StartupDeadline => {
		const passed = today > dueOn;
		return { kind, dueOn, passed, consequence: passed ? consequenceIfPassed : null };
	};

	return [
		make('business_start_notice', businessStartNotice, null),
		make('blue_return_approval', due(blueReturnBase), null),
		make('inventory_method_notice', annualReturnDue, INVENTORY_DEFAULT_CONSEQUENCE),
		make('inventory_method_change', inventoryChangeDue, null),
	];
}
