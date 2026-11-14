jest.mock('server-only', () => ({}), { virtual: true });

import type { SupabaseClient } from '@supabase/supabase-js';
import * as store from '@/lib/accounting/return-refund-store';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = uuid(90);
const KEY = uuid(91);
const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;
const ok = (data: unknown) => ({ data, error: null });
const fail = (message: string, code: string, details: string | null = null) => ({ data: null, error: { message, code, details, hint: null } });

beforeEach(() => {
	jest.resetAllMocks();
});

describe('届いた日', () => {
	test('FREQ-575-AC-02: 受け取りごとの届いた日と直しの跡を camelCase にし、直した人の番号 actorId を計画2の出荷の跡と同じく返す', async () => {
		rpc.mockResolvedValue(
			ok([
				{
					receipt_id: uuid(1),
					arrived_on_original: '2026-11-01',
					arrived_on_current: '2026-11-03',
					version: 1,
					corrections: [{ version: 1, previous_on: '2026-11-01', new_on: '2026-11-03', reason: '到着日の確認', actor_id: uuid(5), created_at: '2026-11-04T01:00:00+00:00' }],
				},
			]),
		);
		const rows = await store.getReturnArrivalInfo(client, [uuid(1)]);
		expect(rpc).toHaveBeenCalledWith('get_return_arrival_info', { _receipt_ids: [uuid(1)] });
		expect(rows).toEqual([
			{
				receiptId: uuid(1),
				arrivedOnOriginal: '2026-11-01',
				arrivedOnCurrent: '2026-11-03',
				version: 1,
				corrections: [{ version: 1, previousOn: '2026-11-01', newOn: '2026-11-03', reason: '到着日の確認', actorId: uuid(5), createdAt: '2026-11-04T01:00:00+00:00' }],
			},
		]);
	});

	test('FREQ-575-AC-02: 戻りの形が違う・知らない鍵は固定の500にし、DB の拒否は表の固定コードにする', async () => {
		for (const bad of [null, {}, [{ receipt_id: 'x' }], [{ receipt_id: uuid(1), arrived_on_original: '2026-11-01', arrived_on_current: '2026-11-01', version: 0, corrections: [], extra: 1 }]]) {
			rpc.mockResolvedValue(ok(bad));
			await expect(store.getReturnArrivalInfo(client, [uuid(1)])).rejects.toMatchObject({ status: 500, code: null });
		}
		rpc.mockResolvedValue(fail('ACCOUNTING_ARGUMENT_INVALID', '22023'));
		await expect(store.getReturnArrivalInfo(client, [uuid(1)])).rejects.toMatchObject({ status: 400, code: 'ACCOUNTING_ARGUMENT_INVALID' });
	});

	test('FREQ-575-AC-01: 直しは DB の入口へ人・版・要求番号を渡し、確定済みなどの断りは 400 の固定コードにする', async () => {
		rpc.mockResolvedValue(ok({ receipt_id: uuid(1), version: 2, previous_on: '2026-11-03', new_on: '2026-11-02', correction_id: uuid(2), replayed: false }));
		const body = { receiptId: uuid(1), newOn: '2026-11-02', reason: '直す', expectedVersion: 1, requestKey: KEY };
		await expect(store.correctReturnArrivalDate(client, ACTOR, body)).resolves.toEqual({
			receiptId: uuid(1),
			version: 2,
			previousOn: '2026-11-03',
			newOn: '2026-11-02',
			correctionId: uuid(2),
			replayed: false,
		});
		expect(rpc).toHaveBeenCalledWith('admin_correct_return_arrival_date', {
			_actor_id: ACTOR,
			_receipt_id: uuid(1),
			_new_on: '2026-11-02',
			_reason: '直す',
			_expected_version: 1,
			_request_key: KEY,
		});
		rpc.mockResolvedValue(fail('RETURN_ARRIVAL_DATE_INVALID', '22023', 'dispute_confirmed'));
		const error = await store.correctReturnArrivalDate(client, ACTOR, body).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 400, code: 'RETURN_ARRIVAL_DATE_INVALID', message: '届いた日を確かめてください。' });
		expect(JSON.stringify(error)).not.toContain('dispute_confirmed');
		rpc.mockResolvedValue(fail('ACCOUNTING_VERSION_CONFLICT', '40001'));
		await expect(store.correctReturnArrivalDate(client, ACTOR, body)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_VERSION_CONFLICT' });
		rpc.mockResolvedValue(fail('ACCOUNTING_FORBIDDEN', '42501'));
		await expect(store.correctReturnArrivalDate(client, ACTOR, body)).rejects.toMatchObject({ status: 403, code: 'ACCOUNTING_FORBIDDEN' });
	});
});

describe('配達日を使う設定', () => {
	const row = { use_carrier_delivery_date: false, changed_at: null, changed_by: null, version: '1' };

	test('FREQ-575-AC-04: 読みは既定オフで、変えた人の番号を返さず、追跡の注意の鍵を付ける', async () => {
		rpc.mockResolvedValue(ok({ ...row, changed_at: '2026-11-10T00:00:00+00:00', changed_by: uuid(5), use_carrier_delivery_date: true, version: '3' }));
		const option = await store.getReturnArrivalOption(client);
		expect(option).toEqual({ useCarrierDeliveryDate: true, changedAt: '2026-11-10T00:00:00+00:00', version: '3', noticeKey: 'return_tracking_unregistered' });
		expect(JSON.stringify(option)).not.toContain(uuid(5));
		expect(rpc).toHaveBeenCalledWith('get_return_arrival_option');
	});

	test('FREQ-575-AC-04: 変えるのは版つきで、版違いは 409 の固定コード', async () => {
		rpc.mockResolvedValue(ok({ ...row, use_carrier_delivery_date: true, changed_at: '2026-11-10T00:00:00+00:00', changed_by: ACTOR, version: '2', replayed: false }));
		const result = await store.setReturnArrivalOption(client, ACTOR, { enabled: true, expectedVersion: '1', requestKey: KEY });
		expect(result).toEqual({ useCarrierDeliveryDate: true, changedAt: '2026-11-10T00:00:00+00:00', version: '2', noticeKey: 'return_tracking_unregistered', replayed: false });
		expect(rpc).toHaveBeenCalledWith('admin_set_return_arrival_option', { _actor_id: ACTOR, _enabled: true, _expected_version: '1', _request_key: KEY });
		rpc.mockResolvedValue(fail('ACCOUNTING_VERSION_CONFLICT', '40001'));
		await expect(store.setReturnArrivalOption(client, ACTOR, { enabled: true, expectedVersion: '1', requestKey: KEY })).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_VERSION_CONFLICT' });
	});
});

describe('返金の状態・取り消しの区分', () => {
	test('FREQ-579-AC-03: 状態の一覧は名前・メールの鍵を持たず、続きの目印を渡す', async () => {
		rpc.mockResolvedValue(
			ok({
				refunds: [{ refund_id: uuid(1), order_id: uuid(2), order_number: 'ORD-00000000', source: 'admin', state: 'canceled', pre_amount: 100, post_amount: 0, owed_pre: 0, owed_post: 0, owed_return: 16875, event_id: uuid(7), event_kind: 'return_receipt', canceled_at: '2026-11-10T00:00:00+00:00' }],
				next_after_at: '2026-11-09T00:00:00+00:00',
				next_after_id: uuid(1),
			}),
		);
		const page = await store.listRefundStates(client, { limit: 50, afterAt: '2026-11-11T00:00:00Z', afterId: uuid(9) });
		expect(rpc).toHaveBeenCalledWith('list_refund_accounting_states', { _limit: 50, _after_at: '2026-11-11T00:00:00Z', _after_id: uuid(9) });
		expect(page.refunds[0]).toEqual({ refundId: uuid(1), orderId: uuid(2), orderNumber: 'ORD-00000000', source: 'admin', state: 'canceled', preAmount: 100, postAmount: 0, owedPre: 0, owedPost: 0, owedReturn: 16875, eventId: uuid(7), eventKind: 'return_receipt', canceledAt: '2026-11-10T00:00:00+00:00' });
		expect(page.nextAfterId).toBe(uuid(1));
		await store.listRefundStates(client, { limit: 50 });
		expect(rpc).toHaveBeenLastCalledWith('list_refund_accounting_states', { _limit: 50, _after_at: null, _after_id: null });
		rpc.mockResolvedValue(ok({ refunds: [{ refund_id: uuid(1), email: 'a@example.test' }], next_after_at: null, next_after_id: null }));
		await expect(store.listRefundStates(client, { limit: 50 })).rejects.toMatchObject({ status: 500, code: null });
	});

	test('FREQ-579-AC-05: 結びの候補は借りの返金の番号を渡して読み、同じ出来事の印を持ち、名前・メールの鍵を持たない', async () => {
		const row = { refund_id: uuid(3), amount: 11250, succeeded_on: '2026-11-07', event_id: uuid(4), event_kind: 'return_receipt', same_event: true };
		rpc.mockResolvedValue(ok({ candidates: [row, { ...row, refund_id: uuid(5), event_id: null, event_kind: 'none', same_event: false }] }));
		const list = await store.listRefundSettleCandidates(client, { owedRefundId: uuid(1) });
		expect(rpc).toHaveBeenCalledWith('list_refund_settle_candidates', { _owed_refund_id: uuid(1) });
		expect(list).toEqual([
			{ refundId: uuid(3), amount: 11250, succeededOn: '2026-11-07', eventId: uuid(4), eventKind: 'return_receipt', sameEvent: true },
			{ refundId: uuid(5), amount: 11250, succeededOn: '2026-11-07', eventId: null, eventKind: 'none', sameEvent: false },
		]);
		rpc.mockResolvedValue(ok({ candidates: [{ ...row, email: 'a@example.test' }] }));
		await expect(store.listRefundSettleCandidates(client, { owedRefundId: uuid(1) })).rejects.toMatchObject({ status: 500, code: null });
		rpc.mockResolvedValue(ok({ candidates: [{ ...row, event_kind: 'other' }] }));
		await expect(store.listRefundSettleCandidates(client, { owedRefundId: uuid(1) })).rejects.toMatchObject({ status: 500, code: null });
	});

	test('FREQ-579-AC-03: 区分は DB の入口へ渡し、2回目と取り消されていない返金は 409 の固定コード', async () => {
		rpc.mockResolvedValue(ok({ refund_id: uuid(1), state: 'owed', event_id: null, replayed: false }));
		const body = { refundId: uuid(1), kind: 'owed' as const, reason: '返す', requestKey: KEY };
		await expect(store.decideRefundCancellation(client, ACTOR, body)).resolves.toEqual({ refundId: uuid(1), state: 'owed', eventId: null, replayed: false });
		expect(rpc).toHaveBeenCalledWith('admin_decide_refund_cancellation', { _actor_id: ACTOR, _refund_id: uuid(1), _kind: 'owed', _reason: '返す', _request_key: KEY });
		rpc.mockResolvedValue(fail('ACCOUNTING_REFUND_CANCEL_DECIDED', '55000'));
		await expect(store.decideRefundCancellation(client, ACTOR, body)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_REFUND_CANCEL_DECIDED', message: 'この返金の取り消しの区分は、もう決まっています。' });
		rpc.mockResolvedValue(fail('ACCOUNTING_REFUND_NOT_CANCELED', '55000'));
		await expect(store.decideRefundCancellation(client, ACTOR, body)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_REFUND_NOT_CANCELED', message: 'この返金は取り消された状態ではありません。' });
		rpc.mockResolvedValue(fail('ACCOUNTING_ARGUMENT_INVALID', '22023'));
		await expect(store.decideRefundCancellation(client, ACTOR, body)).rejects.toMatchObject({ status: 400 });
	});

	test('FREQ-579-AC-03: UNIT_CANCEL_REVERT_REFUSED は 409 と固定コードで、DETAIL ごとに文を分け、生の DETAIL を出さない', async () => {
		const body = { refundId: uuid(1), kind: 'abandoned' as const, reason: 'やめた', requestKey: KEY };
		const revertText = 'この取り消しは元に戻せません。「返すつもり」を選んで振込で返してください。';
		for (const detail of ['ubrr_refund', 'ubrr_event', 'ubrr_later', 'ubrr_fee', 'ubrr_holds', 'ubrr_slot', 'ubrr_identity', null]) {
			rpc.mockResolvedValue(fail('UNIT_CANCEL_REVERT_REFUSED', '22023', detail));
			const error = await store.decideRefundCancellation(client, ACTOR, body).catch((e: unknown) => e);
			expect([detail, error]).toEqual([detail, expect.objectContaining({ status: 409, code: 'UNIT_CANCEL_REVERT_REFUSED', message: revertText })]);
			expect(JSON.stringify(error)).not.toContain('ubrr');
		}
		rpc.mockResolvedValue(fail('UNIT_CANCEL_REVERT_REFUSED', '22023', 'ubrr_status'));
		await expect(store.decideRefundCancellation(client, ACTOR, body)).rejects.toMatchObject({
			status: 409,
			code: 'UNIT_CANCEL_REVERT_STRIPE_RETRY',
			message: 'Stripe への返金をやり直してください。',
		});
		// SQLSTATE が違う同名の誤りは表の拒否にしない
		rpc.mockResolvedValue(fail('UNIT_CANCEL_REVERT_REFUSED', '23505', 'ubrr_status'));
		await expect(store.decideRefundCancellation(client, ACTOR, body)).rejects.toMatchObject({ status: 500, code: null });
	});
});

describe('振込の記録・結び', () => {
	const bank = { orderId: uuid(4), origin: 'pre_shipment' as const, amount: 1000, bankDate: '2026-11-10', bankTxnNo: 'BANK-1', note: null, requestKey: KEY };

	test('FREQ-579-AC-04: 振込の記録は DB の入口へ渡し、残高を超える額と別の内容の再送は 409 の固定コード', async () => {
		rpc.mockResolvedValue(ok({ entry_id: uuid(1), entry_no: 3, period_id: uuid(2), created: true }));
		await expect(store.recordRefundBankTransfer(client, ACTOR, bank)).resolves.toEqual({ entry_id: uuid(1), entry_no: 3, period_id: uuid(2), created: true });
		expect(rpc).toHaveBeenCalledWith('admin_record_refund_bank_transfer', {
			_actor_id: ACTOR,
			_order_id: uuid(4),
			_origin: 'pre_shipment',
			_amount: 1000,
			_bank_date: '2026-11-10',
			_bank_txn_no: 'BANK-1',
			_note: null,
			_request_key: KEY,
		});
		rpc.mockResolvedValue(fail('ACCOUNTING_EVENT_NOT_POSTABLE', '55000'));
		await expect(store.recordRefundBankTransfer(client, ACTOR, bank)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
		rpc.mockResolvedValue(fail('ACCOUNTING_DEDUPE_CONTENT_MISMATCH', '23505'));
		await expect(store.recordRefundBankTransfer(client, ACTOR, bank)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
		rpc.mockResolvedValue(fail('ACCOUNTING_ARGUMENT_INVALID', '22023', 'dispute_confirmed'));
		const error = await store.recordRefundBankTransfer(client, ACTOR, bank).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 400, code: 'ACCOUNTING_ARGUMENT_INVALID' });
		expect(JSON.stringify(error)).not.toContain('dispute_confirmed');
	});

	test('FREQ-579-AC-05: 結びは DB の入口へ渡し、借りの仕訳がまだ・残高を超える時は 409、違う元の返金は 400', async () => {
		rpc.mockResolvedValue(
			ok({ settlement_id: uuid(1), owed_refund_id: uuid(2), paying_refund_id: uuid(3), pre_amount: 500, post_amount: 0, entry_id: uuid(4), entry_no: 8, replayed: false }),
		);
		const body = { owedRefundId: uuid(2), payingRefundId: uuid(3), requestKey: KEY };
		await expect(store.settleOwedByRefund(client, ACTOR, body)).resolves.toEqual({
			settlementId: uuid(1),
			owedRefundId: uuid(2),
			payingRefundId: uuid(3),
			preAmount: 500,
			postAmount: 0,
			entryId: uuid(4),
			entryNo: 8,
			replayed: false,
		});
		expect(rpc).toHaveBeenCalledWith('admin_settle_owed_by_refund', { _actor_id: ACTOR, _owed_refund_id: uuid(2), _paying_refund_id: uuid(3), _request_key: KEY });
		rpc.mockResolvedValue(fail('ACCOUNTING_EVENT_NOT_POSTABLE', '55000'));
		await expect(store.settleOwedByRefund(client, ACTOR, body)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
		rpc.mockResolvedValue(fail('ACCOUNTING_ARGUMENT_INVALID', '22023'));
		await expect(store.settleOwedByRefund(client, ACTOR, body)).rejects.toMatchObject({ status: 400, code: 'ACCOUNTING_ARGUMENT_INVALID' });
		rpc.mockResolvedValue(fail('ACCOUNTING_REQUEST_KEY_CONFLICT', '23505'));
		await expect(store.settleOwedByRefund(client, ACTOR, body)).rejects.toMatchObject({ status: 409, code: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
	});
});

describe('消費税用の返金の一覧', () => {
	const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
		entry_id: uuid(1),
		line_key: `${uuid(1)}:1`,
		refund_date: '2026-11-10',
		order_id: uuid(2),
		order_number: 'ORD-00000000',
		amount: 1100,
		tax_rate: 10,
		tax_amount: 100,
		item_summary: 'シャツ×1',
		original_sale_date: '2026-11-02',
		sale_period_status: 'taxable',
		refund_period_status: 'taxable',
		exclusion: 'none',
		...overrides,
	});
	const list = (rows: unknown[]) => ({ rows, next_after_date: null, next_after_key: null, retention_note: '消費税法施行令58条の2により7年間保存する' });
	const totals = { included_amount: 1100, included_tax: 100, excluded_amount: 0, excluded_by: { before_sale: 0, sale_unbooked: 0, exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 } };
	const arrange = (rows: unknown[], t: unknown = totals) =>
		rpc.mockImplementation(async (name: string) => (name === 'list_consumption_tax_refunds' ? ok(list(rows)) : ok(t)));

	test('FREQ-583-AC-01: 期間・件数・続きの目印を渡し、一覧と合計を camelCase にして、名前・メールの鍵が無い', async () => {
		arrange([row()]);
		const page = await store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 100 });
		expect(rpc).toHaveBeenNthCalledWith(1, 'list_consumption_tax_refunds', { _from: '2026-11-01', _to: '2026-11-30', _limit: 100, _after_date: null, _after_key: null });
		expect(rpc).toHaveBeenNthCalledWith(2, 'get_consumption_tax_refund_totals', { _from: '2026-11-01', _to: '2026-11-30' });
		expect(page.rows[0]).toEqual({
			entryId: uuid(1),
			lineKey: `${uuid(1)}:1`,
			refundDate: '2026-11-10',
			orderId: uuid(2),
			orderNumber: 'ORD-00000000',
			amount: 1100,
			taxRate: 10,
			taxAmount: 100,
			itemSummary: 'シャツ×1',
			originalSaleDate: '2026-11-02',
			salePeriodStatus: 'taxable',
			refundPeriodStatus: 'taxable',
			exclusion: 'none',
		});
		expect(page.retentionNote).toContain('7年間');
		expect(page.totals).toEqual({ includedAmount: 1100, includedTax: 100, excludedAmount: 0, excludedBy: { beforeSale: 0, saleUnbooked: 0, exemptSale1416: 0, afterExit1417: 0 } });
		expect(JSON.stringify(page)).not.toMatch(/email|mail|name"|address/i);
		await store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 10, afterDate: '2026-11-10', afterKey: `${uuid(1)}:1` });
		expect(rpc).toHaveBeenCalledWith('list_consumption_tax_refunds', { _from: '2026-11-01', _to: '2026-11-30', _limit: 10, _after_date: '2026-11-10', _after_key: `${uuid(1)}:1` });
	});

	test('FREQ-583-AC-02: 対象外の5つの理由（sale_unbooked を含む）と、元の売上の日・課税区分が空の行を受け取る', async () => {
		const rows = [
			row({ exclusion: 'before_sale', original_sale_date: null, sale_period_status: null }),
			row({ exclusion: 'sale_unbooked', original_sale_date: null, sale_period_status: null }),
			row({ exclusion: 'exempt_sale_14_1_6', sale_period_status: 'exempt' }),
			row({ exclusion: 'after_exit_14_1_7', refund_period_status: 'exempt' }),
			row({ item_summary: null, amount: -1100, tax_amount: -100 }),
		];
		arrange(rows, { ...totals, excluded_amount: 4400, excluded_by: { before_sale: 1100, sale_unbooked: 1100, exempt_sale_14_1_6: 1100, after_exit_14_1_7: 1100 } });
		const page = await store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 100 });
		expect(page.rows.map((r) => r.exclusion)).toEqual(['before_sale', 'sale_unbooked', 'exempt_sale_14_1_6', 'after_exit_14_1_7', 'none']);
		expect(page.rows[1]).toMatchObject({ originalSaleDate: null, salePeriodStatus: null });
		expect(page.totals.excludedBy.saleUnbooked).toBe(1100);
		expect(page.rows[4]).toMatchObject({ itemSummary: null, amount: -1100, taxAmount: -100 });
	});

	test('FREQ-583-AC-03: 知らない対象外の理由・知らない鍵・合計の欠けは固定の500、続きの目印の誤りは DB の 400', async () => {
		for (const bad of [row({ exclusion: 'other' }), row({ email: 'a@example.test' }), row({ customer_name: '山田' })]) {
			arrange([bad]);
			await expect(store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 100 })).rejects.toMatchObject({ status: 500, code: null });
		}
		arrange([row()], { included_amount: 1 });
		await expect(store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 100 })).rejects.toMatchObject({ status: 500, code: null });
		rpc.mockResolvedValue(fail('ACCOUNTING_ARGUMENT_INVALID', '22023'));
		await expect(store.listConsumptionTaxRefunds(client, { from: '2026-11-01', to: '2026-11-30', limit: 100, afterDate: '2026-11-10', afterKey: `${uuid(1)}:1` })).rejects.toMatchObject({ status: 400, code: 'ACCOUNTING_ARGUMENT_INVALID' });
	});
});
