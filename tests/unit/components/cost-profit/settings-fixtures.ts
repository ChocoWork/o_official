// 設定・期間の画面の試験で使う作り物（GET /api/admin/accounting/periods の答えと fetch の差し替え）。
import { filingDeadlines } from '@/lib/accounting/filing-deadlines';
import { isJpHoliday } from '@/lib/accounting/jp-holidays';
import type { AccountingPeriod } from '@/lib/accounting/period';
import { startupDeadlines } from '@/lib/accounting/startup-deadlines';
import type { AccountingSettings } from '@/lib/accounting/accounting-types';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function solePeriod(year: number, overrides: Partial<AccountingPeriod> = {}): AccountingPeriod {
	return {
		id: uuid(year),
		businessType: 'soleProprietor',
		name: `${year}年（個人）`,
		startsOn: `${year}-01-01`,
		endsOn: `${year}-12-31`,
		corporateTaxExtensionMonths: 0,
		consumptionTaxExtensionMonths: 0,
		consumptionTaxStatus: 'exempt',
		consumptionTaxableFrom: null,
		version: '1',
		...overrides,
	};
}

export function corporatePeriod(term: number, startsOn: string, endsOn: string, overrides: Partial<AccountingPeriod> = {}): AccountingPeriod {
	return {
		id: uuid(9000 + term),
		businessType: 'corporation',
		name: `第${term}期`,
		startsOn,
		endsOn,
		corporateTaxExtensionMonths: 0,
		consumptionTaxExtensionMonths: 0,
		consumptionTaxStatus: 'exempt',
		consumptionTaxableFrom: null,
		version: '1',
		...overrides,
	};
}

export function settingsOf(overrides: Partial<AccountingSettings> = {}): AccountingSettings {
	return {
		businessStartDate: null,
		cutoverOn: '2026-01-01',
		currentBusinessType: 'soleProprietor',
		soleBusinessEndedOn: null,
		version: '3',
		soleEndChanges: [],
		...overrides,
	};
}

/** route と同じく、期限は本物の関数で計算して付ける。 */
export function periodsBody(
	periods: AccountingPeriod[],
	settings: AccountingSettings,
	options: { manageSettings?: boolean; today?: string } = {},
) {
	const deadlines: Record<string, unknown> = {};
	const interim: Record<string, unknown> = {};
	for (const period of periods) {
		const result = filingDeadlines(period, isJpHoliday);
		deadlines[period.id] = result.deadlines;
		interim[period.id] = result.interim;
	}
	const startup = settings.businessStartDate === null
		? []
		: startupDeadlines(settings.businessStartDate, options.today ?? '2026-11-07', isJpHoliday);
	return {
		data: { periods, settings, deadlines, interim, startup },
		permissions: { manageSettings: options.manageSettings ?? true },
	};
}

export type Call = { url: string; method: string; body: unknown; response: Response };
type Handler = (url: URL, method: string, body: unknown) => { status: number; body: unknown } | undefined;

/** fetch を差し替える。handler が undefined を返した要求は 404。送った要求と返した Response を残す。 */
export function mockFetch(handler: Handler) {
	const calls: Call[] = [];
	const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://localhost');
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
		const reply = handler(url, method, body) ?? { status: 404, body: { error: 'not mocked' } };
		const response = new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'Content-Type': 'application/json' },
		});
		calls.push({ url: url.pathname, method, body, response });
		return response;
	});
	global.fetch = fn as unknown as typeof fetch;
	return { fn, calls };
}
