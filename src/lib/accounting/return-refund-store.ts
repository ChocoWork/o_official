import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { classify, parse, rpc } from '@/lib/accounting/accounting-store';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import type {
	CorrectArrivalBody,
	RefundBankTransferBody,
	RefundCancellationBody,
	RefundSettlementBody,
	RefundSettleCandidatesQuery,
	RefundStatesQuery,
	ReturnOptionBody,
	TaxRefundsQuery,
} from '@/lib/accounting/return-refund-schema';
import { REFUND_FACT_EVENT_KINDS, type RefundFactEventKind } from '@/lib/accounting/return-refund-types';

// 返品の届いた日・配達日の設定・返金の取り消しの区分・振込の記録・結び・消費税用の返金の一覧の public 入口を service_role で呼ぶ
// （計画3 Task 10）。失敗は message と SQLSTATE が表と両方一致した時だけ固定コードにし、DB の生の文は持たない。
// 名前・メール・入力者の番号は、DB の読み口が持たないか、ここで返さない。

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signed = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

// ---- 届いた日 ----

const correctionSchema = z
	.object({
		version: z.number().int().min(1),
		previous_on: date,
		new_on: date,
		reason: z.string(),
		actor_id: uuid,
		created_at: timestamp,
	})
	.strict();

const arrivalInfoSchema = z.array(
	z
		.object({
			receipt_id: uuid,
			arrived_on_original: date,
			arrived_on_current: date,
			version: z.number().int().min(0),
			corrections: z.array(correctionSchema),
		})
		.strict(),
);

export type ReturnArrivalInfo = {
	receiptId: string;
	arrivedOnOriginal: string;
	arrivedOnCurrent: string;
	version: number;
	corrections: Array<{ version: number; previousOn: string; newOn: string; reason: string; actorId: string; createdAt: string }>;
};

/** 受け取りごとの届いた日と直しの跡（古い順）。直した人の番号 `actorId` は、計画2の出荷の跡と同じく、DB が返した物をそのまま返す（名前・メールは付けない）。 */
export async function getReturnArrivalInfo(client: SupabaseClient, receiptIds: string[]): Promise<ReturnArrivalInfo[]> {
	const rows = parse(arrivalInfoSchema, await rpc(client, 'get_return_arrival_info', { _receipt_ids: receiptIds }));
	return rows.map((row) => ({
		receiptId: row.receipt_id,
		arrivedOnOriginal: row.arrived_on_original,
		arrivedOnCurrent: row.arrived_on_current,
		version: row.version,
		corrections: row.corrections.map((c) => ({ version: c.version, previousOn: c.previous_on, newOn: c.new_on, reason: c.reason, actorId: c.actor_id, createdAt: c.created_at })),
	}));
}

const correctedSchema = z
	.object({
		receipt_id: uuid,
		version: z.number().int().min(1),
		previous_on: date,
		new_on: date,
		correction_id: uuid,
		replayed: z.boolean(),
	})
	.strict();

export type CorrectedReturnArrival = { receiptId: string; version: number; previousOn: string; newOn: string; correctionId: string; replayed: boolean };

/** 届いた日を直す。`RETURN_ARRIVAL_DATE_INVALID`（未来・申し込みの前・確定済みの取り消しの日以前）は 400。 */
export async function correctReturnArrivalDate(client: SupabaseClient, actorId: string, input: CorrectArrivalBody): Promise<CorrectedReturnArrival> {
	const row = parse(
		correctedSchema,
		await rpc(client, 'admin_correct_return_arrival_date', {
			_actor_id: actorId,
			_receipt_id: input.receiptId,
			_new_on: input.newOn,
			_reason: input.reason,
			_expected_version: input.expectedVersion,
			_request_key: input.requestKey,
		}),
	);
	return { receiptId: row.receipt_id, version: row.version, previousOn: row.previous_on, newOn: row.new_on, correctionId: row.correction_id, replayed: row.replayed };
}

// ---- 配達日を使う設定 ----

const optionReadSchema = z
	.object({ use_carrier_delivery_date: z.boolean(), changed_at: timestamp.nullable(), changed_by: uuid.nullable(), version: z.string().regex(/^[1-9][0-9]*$/) })
	.strict();
const optionWriteSchema = optionReadSchema.extend({ replayed: z.boolean() });

/**
 * 返品の追跡番号を追跡のサービスに登録できるようになるまで、配達日は自動で入らない（人が入れる）。
 * 画面は、この鍵で注意の文を出す（文は画面が持つ）。
 */
export const RETURN_OPTION_NOTICE_KEY = 'return_tracking_unregistered';

export type ReturnArrivalOption = {
	useCarrierDeliveryDate: boolean;
	changedAt: string | null;
	version: string;
	noticeKey: typeof RETURN_OPTION_NOTICE_KEY;
};

const optionOf = (row: z.infer<typeof optionReadSchema>): ReturnArrivalOption => ({
	useCarrierDeliveryDate: row.use_carrier_delivery_date,
	changedAt: row.changed_at,
	version: row.version,
	noticeKey: RETURN_OPTION_NOTICE_KEY,
});

export async function getReturnArrivalOption(client: SupabaseClient): Promise<ReturnArrivalOption> {
	return optionOf(parse(optionReadSchema, await rpc(client, 'get_return_arrival_option')));
}

/** 設定を変える（版つき）。変えた人の番号は返さない。 */
export async function setReturnArrivalOption(
	client: SupabaseClient,
	actorId: string,
	input: ReturnOptionBody,
): Promise<ReturnArrivalOption & { replayed: boolean }> {
	const row = parse(
		optionWriteSchema,
		await rpc(client, 'admin_set_return_arrival_option', {
			_actor_id: actorId,
			_enabled: input.enabled,
			_expected_version: input.expectedVersion,
			_request_key: input.requestKey,
		}),
	);
	return { ...optionOf(row), replayed: row.replayed };
}

// ---- 返金の状態 ----

const refundStatesSchema = z
	.object({
		refunds: z.array(
			z
				.object({
					refund_id: uuid,
					order_id: uuid,
					order_number: z.string().min(1),
					source: z.string().min(1),
					state: z.string().min(1),
					pre_amount: count,
					post_amount: count,
					owed_pre: count,
					owed_post: count,
					owed_return: count,
					event_id: uuid.nullable(),
					event_kind: z.enum(REFUND_FACT_EVENT_KINDS),
					canceled_at: timestamp.nullable(),
				})
				.strict(),
		),
		next_after_at: timestamp.nullable(),
		next_after_id: uuid.nullable(),
	})
	.strict();

export type RefundStateRow = {
	refundId: string;
	orderId: string;
	orderNumber: string;
	source: string;
	state: string;
	preAmount: number;
	postAmount: number;
	owedPre: number;
	owedPost: number;
	/** 返品の返金が返すつもりのまま残っている額（origin return の振込が受ける額）。0 なら返品の借りではない。 */
	owedReturn: number;
	/** 返金の出来事（出来事なしは null・`none`）。`pre_shipment_cancel` の借りは結べず、振込で返す。 */
	eventId: string | null;
	eventKind: RefundFactEventKind;
	canceledAt: string | null;
};
export type RefundStatesPage = { refunds: RefundStateRow[]; nextAfterAt: string | null; nextAfterId: string | null };

/** 取り消しの区分待ち・借りが残る返金の一覧（新しい順）。名前・メールの鍵は DB の読み口が持たない。 */
export async function listRefundStates(client: SupabaseClient, query: RefundStatesQuery): Promise<RefundStatesPage> {
	const page = parse(
		refundStatesSchema,
		await rpc(client, 'list_refund_accounting_states', {
			_limit: query.limit,
			_after_at: query.afterAt ?? null,
			_after_id: query.afterId ?? null,
		}),
	);
	return {
		refunds: page.refunds.map((r) => ({
			refundId: r.refund_id,
			orderId: r.order_id,
			orderNumber: r.order_number,
			source: r.source,
			state: r.state,
			preAmount: r.pre_amount,
			postAmount: r.post_amount,
			owedPre: r.owed_pre,
			owedPost: r.owed_post,
			owedReturn: r.owed_return,
			eventId: r.event_id,
			eventKind: r.event_kind,
			canceledAt: r.canceled_at,
		})),
		nextAfterAt: page.next_after_at,
		nextAfterId: page.next_after_id,
	};
}

// ---- 結びの候補 ----

const settleCandidatesSchema = z
	.object({
		candidates: z.array(
			z
				.object({
					refund_id: uuid,
					amount: count,
					succeeded_on: date,
					event_id: uuid.nullable(),
					event_kind: z.enum(REFUND_FACT_EVENT_KINDS),
					same_event: z.boolean(),
				})
				.strict(),
		),
	})
	.strict();

export type RefundSettleCandidate = {
	refundId: string;
	amount: number;
	/** 成功を知った日（日本の日付）。 */
	succeededOn: string;
	eventId: string | null;
	eventKind: RefundFactEventKind;
	/** 借りの返金と同じ出来事の返金（候補の先頭に並ぶ）。 */
	sameEvent: boolean;
};

/**
 * 借りの返金を結べる返金（同じ注文で、成功して、まだ結ばれておらず、結びの関数が受けるもの）。同じ出来事の返金が先頭。
 * 発送前の取り消しの出来事の借りには候補が無い（空）。名前・メール・住所は DB の読み口が持たない。
 */
export async function listRefundSettleCandidates(client: SupabaseClient, query: RefundSettleCandidatesQuery): Promise<RefundSettleCandidate[]> {
	const data = parse(settleCandidatesSchema, await rpc(client, 'list_refund_settle_candidates', { _owed_refund_id: query.owedRefundId }));
	return data.candidates.map((c) => ({
		refundId: c.refund_id,
		amount: c.amount,
		succeededOn: c.succeeded_on,
		eventId: c.event_id,
		eventKind: c.event_kind,
		sameEvent: c.same_event,
	}));
}

// ---- 取り消しの区分 ----

const cancellationSchema = z
	.object({ refund_id: uuid, state: z.enum(['abandoned', 'owed']), event_id: uuid.nullable(), replayed: z.boolean() })
	.strict();

export type DecidedRefundCancellation = { refundId: string; state: 'abandoned' | 'owed'; eventId: string | null; replayed: boolean };

const UNIT_REVERT_REASON = {
	ubrr_status: 'Stripe への返金をやり直してください。',
	default: 'この取り消しは元に戻せません。「返すつもり」を選んで振込で返してください。',
} as const;

/**
 * 区分の関数の中の `order_unit_revert_cancel` が `UNIT_CANCEL_REVERT_REFUSED / 22023`（DETAIL `ubrr_*`）で断る時は、
 * DETAIL で文を分けて 409 にする（Stripe に届いていない error の返金 `ubrr_status` だけ別の文）。生の DETAIL は返さない。
 */
function classifyDecision(error: unknown): AccountingStoreError {
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		'code' in error &&
		error.message === 'UNIT_CANCEL_REVERT_REFUSED' &&
		error.code === '22023'
	) {
		const details = 'details' in error && typeof error.details === 'string' ? error.details : '';
		// Stripe に届いていない error の返金は別の固定コード（画面は文ではなくコードで選択肢を外す）
		if (details === 'ubrr_status') {
			return new AccountingStoreError('UNIT_CANCEL_REVERT_STRIPE_RETRY', undefined, { message: UNIT_REVERT_REASON.ubrr_status });
		}
		return new AccountingStoreError('UNIT_CANCEL_REVERT_REFUSED', undefined, { message: UNIT_REVERT_REASON.default });
	}
	return classify(error);
}

/**
 * 取り消された返金の区分（店が返金をやめた `abandoned`／返すつもりのまま返せなかった `owed`）を選ぶ。
 * 2回目は `ACCOUNTING_REFUND_CANCEL_DECIDED` の409、取り消されていない返金は `ACCOUNTING_REFUND_NOT_CANCELED` の409。
 */
export async function decideRefundCancellation(client: SupabaseClient, actorId: string, input: RefundCancellationBody): Promise<DecidedRefundCancellation> {
	let response;
	try {
		response = await client.rpc('admin_decide_refund_cancellation', {
			_actor_id: actorId,
			_refund_id: input.refundId,
			_kind: input.kind,
			_reason: input.reason,
			_request_key: input.requestKey,
		});
	} catch (error) {
		throw classify(error);
	}
	if (response.error) throw classifyDecision(response.error);
	const row = parse(cancellationSchema, response.data as unknown);
	return { refundId: row.refund_id, state: row.state, eventId: row.event_id, replayed: row.replayed };
}

// ---- 振込の記録・結び ----

const bankTransferSchema = z
	.object({
		entry_id: uuid,
		entry_no: signed,
		period_id: uuid,
		created: z.boolean(),
	})
	.strict();

export type RecordedRefundBankTransfer = {
	entryId: string;
	entryNo: number;
	periodId: string;
	/** 同じ銀行の取引の番号・元の再送は、前の結果で `false`（何も足していない）。 */
	created: boolean;
};

/**
 * 振込で返した分を記録する。同じ番号・同じ元の再送は何も足さず前の結果（`created: false`）、内容が違うと
 * `ACCOUNTING_DEDUPE_CONTENT_MISMATCH`、借りの残高を超える額は `ACCOUNTING_EVENT_NOT_POSTABLE`。
 * 応答は4つの鍵だけを持つ物に絞る（鍵が増える・消える・型が違うと失敗にする。画面は `created` で重複の文を出す）。
 */
export async function recordRefundBankTransfer(client: SupabaseClient, actorId: string, input: RefundBankTransferBody): Promise<RecordedRefundBankTransfer> {
	const row = parse(
		bankTransferSchema,
		await rpc(client, 'admin_record_refund_bank_transfer', {
			_actor_id: actorId,
			_order_id: input.orderId,
			_origin: input.origin,
			_amount: input.amount,
			_bank_date: input.bankDate,
			_bank_txn_no: input.bankTxnNo,
			_note: input.note,
			_request_key: input.requestKey,
		}),
	);
	return { entryId: row.entry_id, entryNo: row.entry_no, periodId: row.period_id, created: row.created };
}

const settlementSchema = z
	.object({
		settlement_id: uuid,
		owed_refund_id: uuid,
		paying_refund_id: uuid,
		pre_amount: count,
		post_amount: count,
		entry_id: uuid.nullable(),
		entry_no: signed.nullable(),
		replayed: z.boolean(),
	})
	.strict();

export type SettledOwedRefund = {
	settlementId: string;
	owedRefundId: string;
	payingRefundId: string;
	preAmount: number;
	postAmount: number;
	entryId: string | null;
	entryNo: number | null;
	replayed: boolean;
};

/**
 * やり直しの返金で借りを結ぶ。借りの仕訳がまだ・残高を超える時は `ACCOUNTING_EVENT_NOT_POSTABLE` の409、違う元の返金は400。
 * 普通の返品の返金の借り（届いた日の返品の返金待ち。振込で返す）と発送前の取り消しの借りは、DB が `ACCOUNTING_ARGUMENT_INVALID` の400で断る（画面は結ぶ操作を出さない）。
 */
export async function settleOwedByRefund(client: SupabaseClient, actorId: string, input: RefundSettlementBody): Promise<SettledOwedRefund> {
	const row = parse(
		settlementSchema,
		await rpc(client, 'admin_settle_owed_by_refund', {
			_actor_id: actorId,
			_owed_refund_id: input.owedRefundId,
			_paying_refund_id: input.payingRefundId,
			_request_key: input.requestKey,
		}),
	);
	return {
		settlementId: row.settlement_id,
		owedRefundId: row.owed_refund_id,
		payingRefundId: row.paying_refund_id,
		preAmount: row.pre_amount,
		postAmount: row.post_amount,
		entryId: row.entry_id,
		entryNo: row.entry_no,
		replayed: row.replayed,
	};
}

// ---- 消費税用の返金の一覧 ----

/** 消費税の対象外の理由。`sale_unbooked` は出荷の仕訳がまだ無い出荷後の返金（計画3 Task 9）。 */
export const TAX_REFUND_EXCLUSIONS = ['none', 'before_sale', 'sale_unbooked', 'exempt_sale_14_1_6', 'after_exit_14_1_7'] as const;
const periodStatus = z.enum(['taxable', 'exempt']);

const taxRefundRowSchema = z
	.object({
		entry_id: uuid,
		line_key: z.string().min(1),
		refund_date: date,
		order_id: uuid,
		order_number: z.string().min(1),
		amount: signed,
		tax_rate: z.number().int(),
		tax_amount: signed,
		item_summary: z.string().nullable(),
		original_sale_date: date.nullable(),
		sale_period_status: periodStatus.nullable(),
		refund_period_status: periodStatus,
		exclusion: z.enum(TAX_REFUND_EXCLUSIONS),
	})
	.strict();

const taxRefundListSchema = z
	.object({
		rows: z.array(taxRefundRowSchema),
		next_after_date: date.nullable(),
		next_after_key: z.string().nullable(),
		retention_note: z.string(),
	})
	.strict();

const taxRefundTotalsSchema = z
	.object({
		included_amount: signed,
		included_tax: signed,
		excluded_amount: signed,
		excluded_by: z
			.object({ before_sale: signed, sale_unbooked: signed, exempt_sale_14_1_6: signed, after_exit_14_1_7: signed })
			.strict(),
	})
	.strict();

export type TaxRefundRow = {
	entryId: string;
	lineKey: string;
	refundDate: string;
	orderId: string;
	orderNumber: string;
	amount: number;
	taxRate: number;
	taxAmount: number;
	itemSummary: string | null;
	originalSaleDate: string | null;
	salePeriodStatus: 'taxable' | 'exempt' | null;
	refundPeriodStatus: 'taxable' | 'exempt';
	exclusion: (typeof TAX_REFUND_EXCLUSIONS)[number];
};
export type TaxRefundTotals = {
	includedAmount: number;
	includedTax: number;
	excludedAmount: number;
	excludedBy: { beforeSale: number; saleUnbooked: number; exemptSale1416: number; afterExit1417: number };
};
export type TaxRefundsPage = {
	rows: TaxRefundRow[];
	nextAfterDate: string | null;
	nextAfterKey: string | null;
	retentionNote: string;
	totals: TaxRefundTotals;
};

/**
 * 期間（月の初日から月末）の消費税用の返金の一覧と合計。続きの目印が古い・形が違う時は DB が 22023 で断る（400）。
 * 名前・メール・住所は DB の読み口が持たない。
 */
export async function listConsumptionTaxRefunds(client: SupabaseClient, query: TaxRefundsQuery): Promise<TaxRefundsPage> {
	const list = parse(
		taxRefundListSchema,
		await rpc(client, 'list_consumption_tax_refunds', {
			_from: query.from,
			_to: query.to,
			_limit: query.limit,
			_after_date: query.afterDate ?? null,
			_after_key: query.afterKey ?? null,
		}),
	);
	const totals = parse(taxRefundTotalsSchema, await rpc(client, 'get_consumption_tax_refund_totals', { _from: query.from, _to: query.to }));
	return {
		rows: list.rows.map((r) => ({
			entryId: r.entry_id,
			lineKey: r.line_key,
			refundDate: r.refund_date,
			orderId: r.order_id,
			orderNumber: r.order_number,
			amount: r.amount,
			taxRate: r.tax_rate,
			taxAmount: r.tax_amount,
			itemSummary: r.item_summary,
			originalSaleDate: r.original_sale_date,
			salePeriodStatus: r.sale_period_status,
			refundPeriodStatus: r.refund_period_status,
			exclusion: r.exclusion,
		})),
		nextAfterDate: list.next_after_date,
		nextAfterKey: list.next_after_key,
		retentionNote: list.retention_note,
		totals: {
			includedAmount: totals.included_amount,
			includedTax: totals.included_tax,
			excludedAmount: totals.excluded_amount,
			excludedBy: {
				beforeSale: totals.excluded_by.before_sale,
				saleUnbooked: totals.excluded_by.sale_unbooked,
				exemptSale1416: totals.excluded_by.exempt_sale_14_1_6,
				afterExit1417: totals.excluded_by.after_exit_14_1_7,
			},
		},
	};
}
