jest.mock('server-only', () => ({}), { virtual: true });

import type { SupabaseClient } from '@supabase/supabase-js';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import * as store from '@/lib/accounting/posting-store';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rpc = jest.fn();
const maybeSingle = jest.fn();
const chain: Record<string, unknown> = {};
Object.assign(chain, { select: () => chain, eq: () => chain, maybeSingle: () => maybeSingle() });
const from = jest.fn(() => chain);
const client = { rpc, from } as unknown as SupabaseClient;

const ok = (data: unknown) => ({ data, error: null });
const fail = (message: string, code: string, details: string | null = null) => ({ data: null, error: { message, code, details, hint: null } });
const eventRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: uuid(1), event_kind: 'shipment_confirmed', source_table: 'shipment_slips', source_id: uuid(2), order_id: uuid(3), reason: 'payment_journal_missing',
	detail: { order_count: 1 }, first_detected_at: '2026-11-09T01:00:00+00:00', last_detected_at: '2026-11-09T01:10:00+00:00', detection_count: 2,
	resolved_at: null, resolved_entry_id: null, ...overrides,
});
const POSTING = { payments: 1, shipments: 2, stripe: 3, disputes: 4, parked: 5, resolved: 6, has_more: true };

beforeEach(() => {
	jest.resetAllMocks();
	from.mockReturnValue(chain);
});

describe('runAccountingPostingOnce', () => {
	test('FREQ-562-AC-05: accounting_run_postingを呼び、戻りのsnake_caseを直す（SQLが返した数のまま）', async () => {
		rpc.mockResolvedValue(ok(POSTING));
		await expect(store.runAccountingPostingOnce(client)).resolves.toEqual({ payments: 1, shipments: 2, stripe: 3, disputes: 4, parked: 5, resolved: 6, hasMore: true });
		expect(rpc).toHaveBeenCalledWith('accounting_run_posting', { _limit: 50 });
		await store.runAccountingPostingOnce(client, 20);
		expect(rpc).toHaveBeenLastCalledWith('accounting_run_posting', { _limit: 20 });
	});

	test('FREQ-562-AC-05: 件数の上限は1〜200の整数だけ。範囲外はDBを呼ばない', async () => {
		for (const limit of [0, 201, -1, 1.5, Number.NaN]) {
			await expect(store.runAccountingPostingOnce(client, limit)).rejects.toMatchObject({ code: 'ACCOUNTING_ARGUMENT_INVALID', status: 400 });
		}
		expect(rpc).not.toHaveBeenCalled();
		rpc.mockResolvedValue(ok(POSTING));
		await store.runAccountingPostingOnce(client, 200);
		await store.runAccountingPostingOnce(client, 1);
		expect(rpc).toHaveBeenCalledTimes(2);
	});

	test('FREQ-562-AC-05: 戻りの形が違う・負の数・知らない鍵は固定の失敗にする', async () => {
		for (const bad of [null, [], 'x', { ...POSTING, has_more: 'yes' }, { ...POSTING, payments: -1 }, { ...POSTING, extra: 1 }, { payments: 1 }]) {
			rpc.mockResolvedValue(ok(bad));
			await expect(store.runAccountingPostingOnce(client)).rejects.toMatchObject({ status: 500, code: null });
		}
	});
});

describe('DBの拒否の分類', () => {
	test.each([
		['ACCOUNTING_EVENT_NOT_POSTABLE', '55000', 409],
		['ACCOUNTING_PENDING_RESOLVED', '55000', 409],
		['ACCOUNTING_DISPUTE_ACCOUNT_INVALID', '22023', 400],
	])('%s は message と SQLSTATE が一致した時だけ固定コードにする', async (message, sqlstate, status) => {
		rpc.mockResolvedValue(fail(message, sqlstate, 'PRIVATE-MARKER'));
		const error = await store.runAccountingPostingOnce(client).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AccountingStoreError);
		expect(error).toMatchObject({ code: message, status });
		expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
		expect((error as Error).message).not.toContain('PRIVATE-MARKER');
		rpc.mockResolvedValue(fail(message, '23505'));
		await expect(store.runAccountingPostingOnce(client)).rejects.toMatchObject({ status: 500, code: null });
	});

	test('例外が投げられても、生の文を持たない固定の失敗にする', async () => {
		rpc.mockRejectedValue(Object.assign(new Error('PRIVATE-MARKER'), { code: 'XX000' }));
		const error = await store.runAccountingPostingOnce(client).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 500, code: null });
		expect((error as Error).message).toBe('会計の処理に失敗しました。');
	});
});

describe('listPendingEvents', () => {
	test('FREQ-569-AC-01: 一覧と理由ごとの件数を読み、camelCaseの形に直す。名前・メールの鍵が無い', async () => {
		rpc.mockImplementation(async (name: string) => (name === 'list_accounting_pending_events'
			? ok({ events: [eventRow()], next_after_at: '2026-11-09T00:00:00+00:00', next_after_id: uuid(9), open_count: 4 })
			: ok({ open_count: 4, by_reason: { payment_journal_missing: 3, period_missing: 1 }, oldest_at: null })));
		const page = await store.listPendingEvents(client, { includeResolved: true, limit: 10, afterAt: '2026-11-09T02:00:00+00:00', afterId: uuid(8) });
		expect(rpc).toHaveBeenCalledWith('list_accounting_pending_events', { _include_resolved: true, _limit: 10, _after_at: '2026-11-09T02:00:00+00:00', _after_id: uuid(8) });
		expect(rpc).toHaveBeenCalledWith('get_accounting_pending_summary');
		expect(page).toEqual({
			events: [{
				id: uuid(1), eventKind: 'shipment_confirmed', sourceTable: 'shipment_slips', sourceId: uuid(2), orderId: uuid(3), reason: 'payment_journal_missing',
				detail: { order_count: 1 }, firstDetectedAt: '2026-11-09T01:00:00+00:00', lastDetectedAt: '2026-11-09T01:10:00+00:00', detectionCount: 2,
				resolvedAt: null, resolvedEntryId: null,
			}],
			nextAfterAt: '2026-11-09T00:00:00+00:00', nextAfterId: uuid(9), openCount: 4, byReason: { payment_journal_missing: 3, period_missing: 1 },
		});
		expect(JSON.stringify(page)).not.toMatch(/"(name|email|resolved_by|resolution_note)/i);
	});

	test('FREQ-569-AC-01: 目印なしはnullを渡し、知らない理由・知らない鍵・壊れた形は固定の失敗にする', async () => {
		rpc.mockImplementation(async (name: string) => (name === 'list_accounting_pending_events'
			? ok({ events: [], next_after_at: null, next_after_id: null, open_count: 0 })
			: ok({ open_count: 0, by_reason: {}, oldest_at: null })));
		await store.listPendingEvents(client, { includeResolved: false, limit: 50 });
		expect(rpc).toHaveBeenCalledWith('list_accounting_pending_events', { _include_resolved: false, _limit: 50, _after_at: null, _after_id: null });
		for (const event of [eventRow({ reason: 'made_up' }), eventRow({ event_kind: 'made_up' }), { ...eventRow(), customer_name: '山田' }, eventRow({ detail: { nested: { a: 1 } } }), eventRow({ detection_count: -1 })]) {
			rpc.mockImplementation(async (name: string) => (name === 'list_accounting_pending_events'
				? ok({ events: [event], next_after_at: null, next_after_id: null, open_count: 1 })
				: ok({ open_count: 1, by_reason: {}, oldest_at: null })));
			await expect(store.listPendingEvents(client, { includeResolved: false, limit: 50 })).rejects.toMatchObject({ status: 500, code: null });
		}
	});

	test('FREQ-569-AC-01: 未解決の数だけを読む入口もある', async () => {
		rpc.mockResolvedValue(ok({ open_count: 12, by_reason: {}, oldest_at: null }));
		await expect(store.countOpenPendingEvents(client)).resolves.toBe(12);
	});
});

describe('resolvePendingEvent / getSlipDisputeHolds / listJournalShipmentMeta', () => {
	test('FREQ-569-AC-03: 確認済みにする引数を渡し、解決した行を直して返す', async () => {
		rpc.mockResolvedValue(ok(eventRow({ reason: 'before_cutover', resolved_at: '2026-11-09T02:00:00+00:00' })));
		const event = await store.resolvePendingEvent(client, uuid(90), { eventId: uuid(1), note: '確認', requestKey: uuid(91) });
		expect(rpc).toHaveBeenCalledWith('admin_resolve_accounting_pending_event', { _actor_id: uuid(90), _event_id: uuid(1), _note: '確認', _request_key: uuid(91) });
		expect(event).toMatchObject({ reason: 'before_cutover', resolvedAt: '2026-11-09T02:00:00+00:00' });
		expect(JSON.stringify(event)).not.toContain('確認');
	});

	test('FREQ-568-AC-06: 票の判断待ちを読み、注文と取り消しの番号だけ返す。壊れた戻りは固定の失敗', async () => {
		rpc.mockResolvedValue(ok([{ order_id: uuid(3), dispute_id: 'dp_1' }, { order_id: uuid(4), dispute_id: 'dp_2' }]));
		await expect(store.getSlipDisputeHolds(client, uuid(7))).resolves.toEqual([{ orderId: uuid(3), disputeId: 'dp_1' }, { orderId: uuid(4), disputeId: 'dp_2' }]);
		expect(rpc).toHaveBeenCalledWith('get_slip_dispute_holds', { _slip_id: uuid(7) });
		rpc.mockResolvedValue(ok([]));
		await expect(store.getSlipDisputeHolds(client, uuid(7))).resolves.toEqual([]);
		for (const bad of [null, {}, [{ order_id: 'x', dispute_id: 'dp_1' }], [{ order_id: uuid(3) }], [{ order_id: uuid(3), dispute_id: 'dp_1', email: 'a@b' }]]) {
			rpc.mockResolvedValue(ok(bad));
			await expect(store.getSlipDisputeHolds(client, uuid(7))).rejects.toMatchObject({ status: 500 });
		}
	});

	test('FREQ-564-AC-04: 出荷の日と確定した日をcamelCaseで返し、番号が空ならDBを呼ばない', async () => {
		await expect(store.listJournalShipmentMeta(client, [])).resolves.toEqual([]);
		expect(rpc).not.toHaveBeenCalled();
		rpc.mockResolvedValue(ok([{ entry_id: uuid(5), slip_number: 'SL-1', shipment_date: '2026-11-05', confirmed_at: '2026-11-09T01:00:00+00:00' }]));
		await expect(store.listJournalShipmentMeta(client, [uuid(5)])).resolves.toEqual([{ entryId: uuid(5), slipNumber: 'SL-1', shipmentDate: '2026-11-05', confirmedAt: '2026-11-09T01:00:00+00:00' }]);
		expect(rpc).toHaveBeenCalledWith('list_journal_shipment_meta', { _entry_ids: [uuid(5)] });
	});
});

describe('請求書の記録（表の読み）', () => {
	test('FREQ-566-AC-02: 月の記録を読み、入力者の番号は返さない。無ければnull、壊れた形は固定の失敗', async () => {
		maybeSingle.mockResolvedValue({ data: { invoice_month: '2026-10', invoice_total: 100, invoice_tax: 9, document_ref: null, entered_at: '2026-11-09T00:00:00+00:00', version: '3' }, error: null });
		await expect(store.getStripeInvoiceRecord(client, '2026-10')).resolves.toEqual({ month: '2026-10', total: 100, tax: 9, documentRef: null, enteredAt: '2026-11-09T00:00:00+00:00', version: '3' });
		expect(from).toHaveBeenCalledWith('accounting_stripe_invoice_records');
		maybeSingle.mockResolvedValue({ data: null, error: null });
		await expect(store.getStripeInvoiceRecord(client, '2026-10')).resolves.toBeNull();
		maybeSingle.mockResolvedValue({ data: { invoice_month: '2026-10', invoice_total: 100, invoice_tax: 9, document_ref: null, entered_at: '2026-11-09T00:00:00+00:00', version: 1, entered_by: uuid(1) }, error: null });
		await expect(store.getStripeInvoiceRecord(client, '2026-10')).rejects.toMatchObject({ status: 500 });
		maybeSingle.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: 'XX000' } });
		await expect(store.getStripeInvoiceRecord(client, '2026-10')).rejects.toMatchObject({ status: 500, code: null });
	});
});

describe('そのまま渡す読み口と書き口の引数', () => {
	const obj = { ok: true };
	const cases: Array<[string, () => Promise<unknown>, string, Record<string, unknown> | undefined]> = [
		['listDisputeSettings', () => store.listDisputeSettings(client), 'list_dispute_account_settings', undefined],
		['setDisputeSetting', () => store.setDisputeSetting(client, uuid(90), { reason: 'fraudulent', accountCode: '6290', expectedVersion: '2', requestKey: uuid(91) }), 'admin_set_dispute_account_setting',
			{ _actor_id: uuid(90), _reason: 'fraudulent', _account_code: '6290', _expected_version: '2', _request_key: uuid(91) }],
		['listDisputes', () => store.listDisputes(client, { limit: 5 }), 'list_accounting_disputes', { _limit: 5, _after_at: null, _after_id: null }],
		['assignDisputeConfirmed', () => store.assignDisputeConfirmed(client, uuid(90), { disputeId: 'dp_1', requestKey: uuid(91) }), 'admin_assign_dispute_confirmed',
			{ _actor_id: uuid(90), _dispute_id: 'dp_1', _request_key: uuid(91) }],
		['setStripeInvoiceRecord', () => store.setStripeInvoiceRecord(client, uuid(90), { month: '2026-10', total: 1, tax: 2, documentRef: 'r', expectedVersion: null, requestKey: uuid(91) }), 'admin_set_stripe_invoice_record',
			{ _actor_id: uuid(90), _invoice_month: '2026-10', _invoice_total: 1, _invoice_tax: 2, _document_ref: 'r', _expected_version: null, _request_key: uuid(91) }],
		['recordBalanceTopup', () => store.recordBalanceTopup(client, uuid(90), { amount: 5, bankDate: '2026-11-09', bankTxnNo: 'B1', stripeTxnId: null, note: null, requestKey: uuid(91) }), 'admin_record_balance_topup',
			{ _actor_id: uuid(90), _amount: 5, _bank_date: '2026-11-09', _bank_txn_no: 'B1', _stripe_txn_id: null, _note: null, _request_key: uuid(91) }],
		['getStripeBalanceReconciliation', () => store.getStripeBalanceReconciliation(client, '2026-10-31'), 'get_stripe_balance_reconciliation', { _through: '2026-10-31' }],
		['getStripeFeeReconciliation', () => store.getStripeFeeReconciliation(client, '2026-10'), 'get_stripe_fee_reconciliation', { _month: '2026-10' }],
		['getIntakeReconciliation', () => store.getIntakeReconciliation(client, { from: '2026-10-01', to: '2026-10-31' }), 'get_intake_reconciliation', { _from: '2026-10-01', _to: '2026-10-31' }],
		['listDeferredRevenue', () => store.listDeferredRevenue(client, { asOf: '2026-12-31', limit: 10 }), 'list_deferred_revenue', { _as_of: '2026-12-31', _limit: 10, _after_order: null }],
		['listDeferredRevenueAnomalies', () => store.listDeferredRevenueAnomalies(client), 'list_deferred_revenue_anomalies', undefined],
		['listYearEndShipments', () => store.listYearEndShipments(client, { from: '2026-12-25', to: '2027-01-10', limit: 5 }), 'list_year_end_shipments',
			{ _from: '2026-12-25', _to: '2027-01-10', _limit: 5, _after_date: null, _after_slip: null }],
		['checkYearEndShipment', () => store.checkYearEndShipment(client, uuid(90), { slipId: uuid(7), note: null, requestKey: uuid(91) }), 'admin_check_year_end_shipment',
			{ _actor_id: uuid(90), _slip_id: uuid(7), _note: null, _request_key: uuid(91) }],
		['getShippingOptions', () => store.getShippingOptions(client), 'get_shipping_options', undefined],
		['setShippingOptions', () => store.setShippingOptions(client, uuid(90), { carrierDateCheckEnabled: true, expectedVersion: '1', requestKey: uuid(91) }), 'admin_set_shipping_options',
			{ _actor_id: uuid(90), _carrier_date_check_enabled: true, _expected_version: '1', _request_key: uuid(91) }],
		['listCarrierDateGaps', () => store.listCarrierDateGaps(client, { from: '2026-12-25', to: '2027-01-10', limit: 5 }), 'list_carrier_date_gaps', { _from: '2026-12-25', _to: '2027-01-10', _limit: 5 }],
		['getShipmentJournalTrace', () => store.getShipmentJournalTrace(client, uuid(7)), 'get_shipment_journal_trace', { _slip_id: uuid(7) }],
	];

	test.each(cases)('%s は決めた名前と引数でDBを呼び、オブジェクトをそのまま返す', async (_name, call, rpcName, args) => {
		rpc.mockResolvedValue(ok(obj));
		await expect(call()).resolves.toEqual(obj);
		if (args === undefined) expect(rpc).toHaveBeenCalledWith(rpcName);
		else expect(rpc).toHaveBeenCalledWith(rpcName, args);
	});

	test.each(cases)('%s は戻りがオブジェクトでなければ固定の失敗にする', async (_name, call) => {
		rpc.mockResolvedValue(ok('x'));
		await expect(call()).rejects.toMatchObject({ status: 500, code: null });
	});
});
