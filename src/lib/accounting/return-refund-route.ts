import 'server-only';
import { handleAccountingWrite, handleRead } from '@/lib/accounting/accounting-route';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import { toJstDate } from '@/lib/accounting/jst-date';
import { scheduleAccountingPosting } from '@/lib/accounting/posting-runner';
import type { PostingSource } from '@/lib/accounting/posting-types';
import {
	correctArrivalBodySchema,
	parseRefundStatesQuery,
	parseReturnArrivalQuery,
	parseTaxRefundsQuery,
	refundBankTransferBodySchema,
	refundCancellationBodySchema,
	refundSettlementBodySchema,
	returnOptionBodySchema,
} from '@/lib/accounting/return-refund-schema';
import {
	correctReturnArrivalDate,
	decideRefundCancellation,
	getReturnArrivalInfo,
	getReturnArrivalOption,
	listConsumptionTaxRefunds,
	listRefundStates,
	recordRefundBankTransfer,
	setReturnArrivalOption,
	settleOwedByRefund,
} from '@/lib/accounting/return-refund-store';
import type { PermissionCode } from '@/lib/auth/admin-rbac';

// 返品の届いた日・配達日の設定・返金の取り消しの区分・振込の記録・結び・消費税用の返金の一覧の route の本体（計画3 Task 10）。
// 読みは accounting-route の handleRead（全応答 no-store）、書きは handleAccountingWrite
// （認可 → CSRF → IP の制限 → actor の制限 → 入力 → store → 監査 → 応答。回数の制限の窓は600秒）を使う。route ファイルは薄く保つ。
// 監査は番号と結果だけ。理由の本文・日・額・銀行の取引の番号・名前・メールは載せない。

const label = (method: string, path: string): string => `${method} /api/admin/accounting/${path}`;
const invalid = (): AccountingStoreError => new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID');

const ORDERS_READ: PermissionCode = 'admin.orders.read';
const FINANCE_MANAGE: PermissionCode = 'admin.finance.manage';
const ENTRIES_CORRECT: PermissionCode = 'admin.accounting.entries.correct';

const queryOf = (request: Request): URLSearchParams => new URL(request.url).searchParams;

/** 書き込みが成功（2xx）した時だけ、応答を返した後に計上係を流す（失敗は握る。応答は変えない）。 */
async function thenPost(source: PostingSource, response: Promise<Response>): Promise<Response> {
	const result = await response;
	if (result.status >= 200 && result.status < 300) scheduleAccountingPosting(source);
	return result;
}

// ---- 届いた日 ----

/** 受け取りごとの届いた日と直しの跡（最大200件）。権限は admin.orders.read。 */
export function handleReturnArrivalGet(request: Request): Promise<Response> {
	return handleRead(
		request,
		label('GET', 'return-arrival'),
		async (client, req) => {
			const receiptIds = parseReturnArrivalQuery(queryOf(req));
			if (!receiptIds) throw invalid();
			return { arrivals: await getReturnArrivalInfo(client, receiptIds) };
		},
		ORDERS_READ,
	);
}

/** 届いた日を直す。監査は受け取りの番号と結果だけ（理由の本文・日は入れない）。 */
export function handleReturnArrivalPost(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('POST', 'return-arrival'),
		action: 'admin.accounting.return.arrival',
		permission: ENTRIES_CORRECT,
		withId: false,
		status: 200,
		schema: correctArrivalBodySchema,
		run: (client, actorId, _id, body) => correctReturnArrivalDate(client, actorId, body),
		audit: (result) => ({
			resourceId: result.receiptId,
			metadata: { receipt_id: result.receiptId, result: result.replayed ? 'replayed' : 'corrected' },
		}),
		respond: async (_client, result) => ({ arrival: result }),
	});
}

// ---- 配達日を使う設定 ----

export function handleReturnOptionsGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'return-options'), async (client) => ({ option: await getReturnArrivalOption(client) }));
}

/** 配達日を使う設定。監査は結果だけ。 */
export function handleReturnOptionsPut(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('PUT', 'return-options'),
		action: 'admin.accounting.return.option',
		withId: false,
		status: 200,
		schema: returnOptionBodySchema,
		run: (client, actorId, _id, body) => setReturnArrivalOption(client, actorId, body),
		audit: (result) => ({
			resourceId: null,
			metadata: { result: result.replayed ? 'replayed' : result.useCarrierDeliveryDate ? 'enabled' : 'disabled' },
		}),
		respond: async (_client, result) => ({ option: { useCarrierDeliveryDate: result.useCarrierDeliveryDate, changedAt: result.changedAt, version: result.version, noticeKey: result.noticeKey } }),
	});
}

// ---- 返金の状態・取り消しの区分・振込・結び ----

/** 取り消しの区分待ち・借りが残る返金の一覧。名前・メールを含めない。 */
export function handleRefundStatesGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'refund-states'), async (client, req) => {
		const query = parseRefundStatesQuery(queryOf(req));
		if (!query) throw invalid();
		return listRefundStates(client, query);
	});
}

/** 取り消しの区分を選ぶ。監査は返金の番号と区分だけ（理由の本文は入れない）。 */
export function handleRefundCancellationPost(request: Request): Promise<Response> {
	return thenPost(
		'refund_cancel',
		handleAccountingWrite(request, null, {
			label: label('POST', 'refund-cancellations'),
			action: 'admin.accounting.refund.cancel_decision',
			permission: ENTRIES_CORRECT,
			withId: false,
			status: 200,
			schema: refundCancellationBodySchema,
			run: (client, actorId, _id, body) => decideRefundCancellation(client, actorId, body),
			audit: (result) => ({ resourceId: result.refundId, metadata: { refund_id: result.refundId, result: result.state } }),
			respond: async (_client, result) => ({ decision: result }),
		}),
	);
}

/** 振込で返した分の記録。日は今日（日本時間）まで。監査は結果だけ（金額・銀行の取引の番号は入れない）。 */
export function handleRefundBankTransferPost(request: Request): Promise<Response> {
	return thenPost(
		'refund_bank',
		handleAccountingWrite(request, null, {
			label: label('POST', 'refund-bank-transfers'),
			action: 'admin.accounting.refund.bank',
			permission: FINANCE_MANAGE,
			withId: false,
			status: 200,
			schema: refundBankTransferBodySchema(toJstDate(new Date())),
			run: (client, actorId, _id, body) => recordRefundBankTransfer(client, actorId, body),
			audit: (result) => ({ resourceId: null, metadata: { result: result.created === false ? 'replayed' : 'recorded' } }),
			respond: async (_client, result) => ({ transfer: result }),
		}),
	);
}

/** やり直しの結び。監査は借りの返金の番号と結果だけ（金額は入れない）。 */
export function handleRefundSettlementPost(request: Request): Promise<Response> {
	return thenPost(
		'refund_settle',
		handleAccountingWrite(request, null, {
			label: label('POST', 'refund-settlements'),
			action: 'admin.accounting.refund.settle',
			permission: ENTRIES_CORRECT,
			withId: false,
			status: 200,
			schema: refundSettlementBodySchema,
			run: (client, actorId, _id, body) => settleOwedByRefund(client, actorId, body),
			audit: (result) => ({
				resourceId: result.owedRefundId,
				metadata: { refund_id: result.owedRefundId, result: result.replayed ? 'replayed' : 'settled' },
			}),
			respond: async (_client, result) => ({ settlement: result }),
		}),
	);
}

// ---- 消費税用の返金の一覧 ----

/** 期間（月）の一覧と合計。続きの目印が不正なら400。 */
export function handleTaxRefundsGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'tax-refunds'), async (client, req) => {
		const query = parseTaxRefundsQuery(queryOf(req));
		if (!query) throw invalid();
		return listConsumptionTaxRefunds(client, query);
	});
}
