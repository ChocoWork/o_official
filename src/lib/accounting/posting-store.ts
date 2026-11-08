import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
	ACCOUNTING_ERRORS,
	AccountingStoreError,
	SOLE_ENDED_NOT_SWITCHED,
	type AccountingErrorCode,
	type ShipmentMeta,
} from '@/lib/accounting/accounting-types';
import { ACCOUNTING_EVENT_KINDS } from '@/lib/accounting/event-kinds';
import {
	MAX_POSTING_BATCH,
	PENDING_REASONS,
	DEFAULT_POSTING_BATCH,
	type PendingEvent,
	type PendingEventsPage,
	type PendingReason,
	type PostingRunResult,
	type SlipDisputeHold,
} from '@/lib/accounting/posting-types';

// 計上待ち・計上係・支払いの取り消し・Stripe の記録・照合・年末の照合の public 入口を service_role で呼ぶ。
// 失敗は message と SQLSTATE が表と両方一致した時だけ固定コードにし、DB の生の文は持たない（accounting-store と同じ規則）。

const sqlstateOf = (error: unknown): unknown =>
	error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

function classify(error: unknown): AccountingStoreError {
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		'code' in error &&
		typeof error.message === 'string' &&
		Object.hasOwn(ACCOUNTING_ERRORS, error.message) &&
		ACCOUNTING_ERRORS[error.message as AccountingErrorCode][0] === error.code
	) {
		const details = 'details' in error ? error.details : undefined;
		return new AccountingStoreError(error.message, undefined, { soleEndedNotSwitched: details === SOLE_ENDED_NOT_SWITCHED });
	}
	return new AccountingStoreError(null, sqlstateOf(error));
}

async function rpc(client: SupabaseClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
	let response;
	try {
		response = args === undefined ? await client.rpc(name) : await client.rpc(name, args);
	} catch (error) {
		throw new AccountingStoreError(null, sqlstateOf(error));
	}
	if (response.error) throw classify(response.error);
	return response.data as unknown;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
	const result = schema.safeParse(raw);
	if (!result.success) throw new AccountingStoreError();
	return result.data;
}

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)));
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** 形の決まった中身は route が型を持たず、DB が返したオブジェクトをそのまま渡す（キーは snake_case のまま）。 */
const objectSchema = z.record(z.string(), z.unknown());

const postingResultSchema = z
	.object({
		payments: count,
		shipments: count,
		stripe: count,
		disputes: count,
		parked: count,
		resolved: count,
		has_more: z.boolean(),
	})
	.strict();

/** 計上係を1回呼ぶ（最大 `limit` 件）。繰り返しは posting-runner が決める。 */
export async function runAccountingPostingOnce(client: SupabaseClient, limit: number = DEFAULT_POSTING_BATCH): Promise<PostingRunResult> {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_POSTING_BATCH) throw new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID');
	const raw = parse(postingResultSchema, await rpc(client, 'accounting_run_posting', { _limit: limit }));
	return {
		payments: raw.payments,
		shipments: raw.shipments,
		stripe: raw.stripe,
		disputes: raw.disputes,
		parked: raw.parked,
		resolved: raw.resolved,
		hasMore: raw.has_more,
	};
}

const detailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const pendingEventSchema = z
	.object({
		id: uuid,
		event_kind: z.enum(ACCOUNTING_EVENT_KINDS),
		source_table: z.string().min(1),
		source_id: z.string().min(1),
		order_id: z.string().nullable(),
		reason: z.enum(PENDING_REASONS),
		detail: detailSchema,
		first_detected_at: timestamp,
		last_detected_at: timestamp,
		detection_count: count,
		resolved_at: timestamp.nullable(),
		resolved_entry_id: uuid.nullable(),
	})
	.strict()
	.transform(
		(e): PendingEvent => ({
			id: e.id,
			eventKind: e.event_kind,
			sourceTable: e.source_table,
			sourceId: e.source_id,
			orderId: e.order_id,
			reason: e.reason,
			detail: e.detail,
			firstDetectedAt: e.first_detected_at,
			lastDetectedAt: e.last_detected_at,
			detectionCount: e.detection_count,
			resolvedAt: e.resolved_at,
			resolvedEntryId: e.resolved_entry_id,
		}),
	);

const pendingPageSchema = z
	.object({
		events: z.array(pendingEventSchema),
		next_after_at: timestamp.nullable(),
		next_after_id: uuid.nullable(),
		open_count: count,
	})
	.strict();
const pendingSummarySchema = z
	.object({ open_count: count, by_reason: z.record(z.string(), count), oldest_at: timestamp.nullable() })
	.strict();

export type PendingEventsQueryInput = { includeResolved: boolean; limit: number; afterAt?: string; afterId?: string };

/** 計上待ちの一覧（新しい順）。名前・メールの鍵は DB の読み口が持たない。未解決の理由ごとの件数も付ける。 */
export async function listPendingEvents(client: SupabaseClient, query: PendingEventsQueryInput): Promise<PendingEventsPage> {
	const page = parse(
		pendingPageSchema,
		await rpc(client, 'list_accounting_pending_events', {
			_include_resolved: query.includeResolved,
			_limit: query.limit,
			_after_at: query.afterAt ?? null,
			_after_id: query.afterId ?? null,
		}),
	);
	const summary = parse(pendingSummarySchema, await rpc(client, 'get_accounting_pending_summary'));
	const byReason: Partial<Record<PendingReason, number>> = {};
	for (const reason of PENDING_REASONS) {
		const n = summary.by_reason[reason];
		if (n !== undefined) byReason[reason] = n;
	}
	return {
		events: page.events,
		nextAfterAt: page.next_after_at,
		nextAfterId: page.next_after_id,
		openCount: page.open_count,
		byReason,
	};
}

/** 未解決の計上待ちの数（cron の応答に付ける）。 */
export async function countOpenPendingEvents(client: SupabaseClient): Promise<number> {
	return parse(pendingSummarySchema, await rpc(client, 'get_accounting_pending_summary')).open_count;
}

/** 確認済みにする（before_cutover・no_revenue だけ。ほかは DB が断る）。メモの本文は DB に渡すだけで、返さない。 */
export async function resolvePendingEvent(
	client: SupabaseClient,
	actorId: string,
	input: { eventId: string; note: string; requestKey: string },
): Promise<PendingEvent> {
	return parse(
		pendingEventSchema,
		await rpc(client, 'admin_resolve_accounting_pending_event', {
			_actor_id: actorId,
			_event_id: input.eventId,
			_note: input.note,
			_request_key: input.requestKey,
		}),
	);
}

const slipHoldsSchema = z.array(z.object({ order_id: uuid, dispute_id: z.string().min(1) }).strict());

/** 発送票の注文を止めている、判断待ちの支払いの取り消し（4-e3）。1件でもあれば確定の前に止める。 */
export async function getSlipDisputeHolds(client: SupabaseClient, slipId: string): Promise<SlipDisputeHold[]> {
	const rows = parse(slipHoldsSchema, await rpc(client, 'get_slip_dispute_holds', { _slip_id: slipId }));
	return rows.map((row) => ({ orderId: row.order_id, disputeId: row.dispute_id }));
}

const requestKeyArgs = (key: string) => ({ _request_key: key });

export async function listDisputeSettings(client: SupabaseClient): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'list_dispute_account_settings'));
}

export async function setDisputeSetting(
	client: SupabaseClient,
	actorId: string,
	input: { reason: string; accountCode: string; expectedVersion: string | null; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_set_dispute_account_setting', {
			_actor_id: actorId,
			_reason: input.reason,
			_account_code: input.accountCode,
			_expected_version: input.expectedVersion,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

export async function listDisputes(
	client: SupabaseClient,
	query: { limit: number; afterAt?: string; afterId?: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'list_accounting_disputes', {
			_limit: query.limit,
			_after_at: query.afterAt ?? null,
			_after_id: query.afterId ?? null,
		}),
	);
}

export async function assignDisputeConfirmed(
	client: SupabaseClient,
	actorId: string,
	input: { disputeId: string; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_assign_dispute_confirmed', {
			_actor_id: actorId,
			_dispute_id: input.disputeId,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

const invoiceRowSchema = z
	.object({
		invoice_month: z.string(),
		invoice_total: z.number().int().min(0),
		invoice_tax: z.number().int().min(0),
		document_ref: z.string().nullable(),
		entered_at: timestamp,
		version: z.union([z.number().int().min(1), z.string().regex(/^[1-9][0-9]*$/)]),
	})
	.strict();

export type StripeInvoiceRecord = {
	month: string;
	total: number;
	tax: number;
	documentRef: string | null;
	enteredAt: string;
	version: string;
};

/** 月の適格請求書の記録（無ければ null）。入力者の番号は返さない。 */
export async function getStripeInvoiceRecord(client: SupabaseClient, month: string): Promise<StripeInvoiceRecord | null> {
	let response;
	try {
		response = await client
			.from('accounting_stripe_invoice_records')
			.select('invoice_month, invoice_total, invoice_tax, document_ref, entered_at, version')
			.eq('invoice_month', month)
			.maybeSingle();
	} catch (error) {
		throw new AccountingStoreError(null, sqlstateOf(error));
	}
	if (response.error) throw classify(response.error);
	if (response.data === null) return null;
	const row = parse(invoiceRowSchema, response.data);
	return {
		month: row.invoice_month,
		total: row.invoice_total,
		tax: row.invoice_tax,
		documentRef: row.document_ref,
		enteredAt: row.entered_at,
		version: String(row.version),
	};
}

export async function setStripeInvoiceRecord(
	client: SupabaseClient,
	actorId: string,
	input: { month: string; total: number; tax: number; documentRef: string | null; expectedVersion: string | null; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_set_stripe_invoice_record', {
			_actor_id: actorId,
			_invoice_month: input.month,
			_invoice_total: input.total,
			_invoice_tax: input.tax,
			_document_ref: input.documentRef,
			_expected_version: input.expectedVersion,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

export async function recordBalanceTopup(
	client: SupabaseClient,
	actorId: string,
	input: { amount: number; bankDate: string; bankTxnNo: string | null; stripeTxnId: string | null; note: string | null; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_record_balance_topup', {
			_actor_id: actorId,
			_amount: input.amount,
			_bank_date: input.bankDate,
			_bank_txn_no: input.bankTxnNo,
			_stripe_txn_id: input.stripeTxnId,
			_note: input.note,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

export async function getStripeBalanceReconciliation(client: SupabaseClient, through: string): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'get_stripe_balance_reconciliation', { _through: through }));
}

export async function getStripeFeeReconciliation(client: SupabaseClient, month: string): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'get_stripe_fee_reconciliation', { _month: month }));
}

/** 受注残の2段の照らし合わせ。平らなオブジェクトをそのまま返す（Ruling P2-T7-shape）。 */
export async function getIntakeReconciliation(client: SupabaseClient, range: { from: string; to: string }): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'get_intake_reconciliation', { _from: range.from, _to: range.to }));
}

export async function listDeferredRevenue(
	client: SupabaseClient,
	query: { asOf: string; limit: number; afterOrder?: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'list_deferred_revenue', { _as_of: query.asOf, _limit: query.limit, _after_order: query.afterOrder ?? null }),
	);
}

export async function listDeferredRevenueAnomalies(client: SupabaseClient): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'list_deferred_revenue_anomalies'));
}

export async function listYearEndShipments(
	client: SupabaseClient,
	query: { from: string; to: string; limit: number; afterDate?: string; afterSlip?: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'list_year_end_shipments', {
			_from: query.from,
			_to: query.to,
			_limit: query.limit,
			_after_date: query.afterDate ?? null,
			_after_slip: query.afterSlip ?? null,
		}),
	);
}

export async function checkYearEndShipment(
	client: SupabaseClient,
	actorId: string,
	input: { slipId: string; note: string | null; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_check_year_end_shipment', {
			_actor_id: actorId,
			_slip_id: input.slipId,
			_note: input.note,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

export async function getShippingOptions(client: SupabaseClient): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'get_shipping_options'));
}

export async function setShippingOptions(
	client: SupabaseClient,
	actorId: string,
	input: { carrierDateCheckEnabled: boolean; expectedVersion: string; requestKey: string },
): Promise<Record<string, unknown>> {
	return parse(
		objectSchema,
		await rpc(client, 'admin_set_shipping_options', {
			_actor_id: actorId,
			_carrier_date_check_enabled: input.carrierDateCheckEnabled,
			_expected_version: input.expectedVersion,
			...requestKeyArgs(input.requestKey),
		}),
	);
}

/** 運送会社の受付の日とのずれ。`has_more` はそのまま通す（オフの間は `enabled:false` と空の一覧）。 */
export async function listCarrierDateGaps(
	client: SupabaseClient,
	query: { from: string; to: string; limit: number },
): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'list_carrier_date_gaps', { _from: query.from, _to: query.to, _limit: query.limit }));
}

export async function getShipmentJournalTrace(client: SupabaseClient, slipId: string): Promise<Record<string, unknown>> {
	return parse(objectSchema, await rpc(client, 'get_shipment_journal_trace', { _slip_id: slipId }));
}

const shipmentMetaRowsSchema = z.array(
	z.object({ entry_id: uuid, slip_number: z.string().min(1), shipment_date: date, confirmed_at: timestamp }).strict(),
);

/** 出荷の仕訳に付ける、出荷した日と発送票を確定した日（最大200件）。 */
export async function listJournalShipmentMeta(client: SupabaseClient, entryIds: string[]): Promise<ShipmentMeta[]> {
	if (entryIds.length === 0) return [];
	const rows = parse(shipmentMetaRowsSchema, await rpc(client, 'list_journal_shipment_meta', { _entry_ids: entryIds }));
	return rows.map((row) => ({
		entryId: row.entry_id,
		slipNumber: row.slip_number,
		shipmentDate: row.shipment_date,
		confirmedAt: row.confirmed_at,
	}));
}
