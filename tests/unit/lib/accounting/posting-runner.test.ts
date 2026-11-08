jest.mock('server-only', () => ({}), { virtual: true });
const mockAfter = jest.fn();
jest.mock('next/server', () => ({ after: (...args: unknown[]) => mockAfter(...args) }));
const mockCreateClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: (...args: unknown[]) => mockCreateClient(...args) }));
const mockOnce = jest.fn();
jest.mock('@/lib/accounting/posting-store', () => ({ runAccountingPostingOnce: (...args: unknown[]) => mockOnce(...args) }));

import type { SupabaseClient } from '@supabase/supabase-js';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import {
	runAccountingPosting,
	safeRunAccountingPosting,
	scheduleAccountingPosting,
	WEBHOOK_POSTING_OPTIONS,
} from '@/lib/accounting/posting-runner';
import { MAX_POSTING_LOOPS, type PostingRunResult } from '@/lib/accounting/posting-types';

const client = { name: 'service-role' } as unknown as SupabaseClient;
const result = (overrides: Partial<PostingRunResult> = {}): PostingRunResult => ({
	payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, hasMore: false, ...overrides,
});

let error: jest.SpyInstance;
beforeEach(() => {
	jest.resetAllMocks();
	error = jest.spyOn(console, 'error').mockImplementation(() => {});
	mockCreateClient.mockResolvedValue(client);
});
afterEach(() => error.mockRestore());

describe('runAccountingPosting', () => {
	test('FREQ-562-AC-05: 計上係の呼び出しはhas_moreが偽になるまで繰り返し、数は回ごとの合計、hasMoreは最後の値', async () => {
		mockOnce
			.mockResolvedValueOnce(result({ payments: 50, parked: 1, hasMore: true }))
			.mockResolvedValueOnce(result({ payments: 20, shipments: 5, stripe: 3, disputes: 1, parked: 2, resolved: 4, hasMore: true }))
			.mockResolvedValueOnce(result({ shipments: 1, resolved: 1, hasMore: false }));

		await expect(runAccountingPosting(client)).resolves.toEqual({
			payments: 70, shipments: 6, stripe: 3, disputes: 1, parked: 3, resolved: 5, hasMore: false,
		});
		expect(mockOnce).toHaveBeenCalledTimes(3);
		// 1回の件数の上限の既定は50。
		for (const call of mockOnce.mock.calls) expect(call).toEqual([client, 50]);
	});

	test('FREQ-562-AC-05: 計上係の呼び出しは20回で止まり、止まった時のhasMoreは真のまま', async () => {
		mockOnce.mockResolvedValue(result({ payments: 1, hasMore: true }));
		const total = await runAccountingPosting(client);
		expect(MAX_POSTING_LOOPS).toBe(20);
		expect(mockOnce).toHaveBeenCalledTimes(20);
		expect(total).toEqual(result({ payments: 20, hasMore: true }));
	});

	test('FREQ-562-AC-05: hasMoreだけで続きを決める（止めた件数や解決した件数が多くても続けない）', async () => {
		mockOnce.mockResolvedValue(result({ parked: 200, resolved: 200, hasMore: false }));
		await runAccountingPosting(client);
		expect(mockOnce).toHaveBeenCalledTimes(1);
	});

	test('FREQ-562-AC-05: 件数の上限と繰り返しの回数は呼び出し側が絞れる（回数は20を超えない）', async () => {
		mockOnce.mockResolvedValue(result({ hasMore: true }));
		await runAccountingPosting(client, { limit: 20, maxLoops: 1 });
		expect(mockOnce).toHaveBeenCalledTimes(1);
		expect(mockOnce).toHaveBeenCalledWith(client, 20);
		mockOnce.mockClear();
		await runAccountingPosting(client, { maxLoops: 99 });
		expect(mockOnce).toHaveBeenCalledTimes(20);
	});

	test('FREQ-562-AC-05: 途中で失敗したら例外をそのまま投げる（握るのは safe の側）', async () => {
		mockOnce.mockResolvedValueOnce(result({ hasMore: true })).mockRejectedValueOnce(new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID'));
		await expect(runAccountingPosting(client)).rejects.toBeInstanceOf(AccountingStoreError);
	});
});

describe('safeRunAccountingPosting', () => {
	test('FREQ-562-AC-05: 呼び出しの失敗はログだけで、呼び出し側を失敗にしない', async () => {
		mockOnce.mockRejectedValue(new AccountingStoreError(null, 'XX000'));
		await expect(safeRunAccountingPosting('shipment_confirm')).resolves.toBeNull();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith('[accounting.posting]', 'shipment_confirm', 'XX000');
	});

	test('FREQ-562-AC-05: ログに残すのは入口の名前と失敗の種類だけ（個人の情報・金額・DBの文を書かない）', async () => {
		mockOnce.mockRejectedValue(Object.assign(new Error('PRIVATE-MARKER 氏名 住所 12345円'), { code: 'XX000' }));
		await safeRunAccountingPosting('cron');
		expect(error).toHaveBeenCalledWith('[accounting.posting]', 'cron', 'Error');
		expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE-MARKER');
		mockCreateClient.mockRejectedValue(new TypeError('PRIVATE-MARKER'));
		await expect(safeRunAccountingPosting('manual')).resolves.toBeNull();
		expect(error).toHaveBeenLastCalledWith('[accounting.posting]', 'manual', 'TypeError');
		mockCreateClient.mockRejectedValue('文字列の例外');
		await safeRunAccountingPosting('webhook');
		expect(error).toHaveBeenLastCalledWith('[accounting.posting]', 'webhook', 'UnknownError');
	});

	test('FREQ-562-AC-05: 成功の時は結果を返し、webhookの値（limit 20・繰り返さない）を渡せる', async () => {
		mockOnce.mockResolvedValue(result({ payments: 2, hasMore: true }));
		await expect(safeRunAccountingPosting('webhook', WEBHOOK_POSTING_OPTIONS)).resolves.toEqual(result({ payments: 2, hasMore: true }));
		expect(WEBHOOK_POSTING_OPTIONS).toEqual({ limit: 20, maxLoops: 1 });
		expect(mockOnce).toHaveBeenCalledTimes(1);
		expect(mockOnce).toHaveBeenCalledWith(client, 20);
		expect(error).not.toHaveBeenCalled();
	});
});

describe('scheduleAccountingPosting', () => {
	test('FREQ-562-AC-05: 応答の後に Next の after() で係を流す（その場では流さない）', async () => {
		mockOnce.mockResolvedValue(result());
		scheduleAccountingPosting('shipment_cancel');
		expect(mockAfter).toHaveBeenCalledTimes(1);
		expect(mockOnce).not.toHaveBeenCalled();
		await (mockAfter.mock.calls[0][0] as () => Promise<void>)();
		expect(mockOnce).toHaveBeenCalledTimes(1);
	});

	test('FREQ-562-AC-05: after() の中で係が失敗してもログだけ。after() が使えない時も投げずにログだけ', async () => {
		mockOnce.mockRejectedValue(new Error('PRIVATE-MARKER'));
		scheduleAccountingPosting('shipment_date');
		await expect((mockAfter.mock.calls[0][0] as () => Promise<void>)()).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith('[accounting.posting]', 'shipment_date', 'Error');
		mockAfter.mockImplementation(() => { throw new Error('outside of a request scope PRIVATE-MARKER'); });
		expect(() => scheduleAccountingPosting('bank_confirm')).not.toThrow();
		expect(error).toHaveBeenLastCalledWith('[accounting.posting]', 'bank_confirm', 'schedule_Error');
		expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE-MARKER');
	});
});
