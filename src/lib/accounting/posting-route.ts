import 'server-only';
import {
	handleAccountingWrite,
	handleRead,
	type AccountingContext,
} from '@/lib/accounting/accounting-route';
import { getAccountingSettings } from '@/lib/accounting/accounting-store';
import { AccountingListRestartError, AccountingStoreError } from '@/lib/accounting/accounting-types';
import { toJstDate } from '@/lib/accounting/jst-date';
import {
	assignDisputeBodySchema,
	disputeIdSchema,
	disputeSettingBodySchema,
	invoiceBodySchema,
	parseDeferredRevenueQuery,
	parseDisputesQuery,
	parseInvoiceQuery,
	parsePendingEventsQuery,
	parseReconciliationQuery,
	parseShipmentTraceQuery,
	parseYearEndQuery,
	resolvePendingBodySchema,
	runPostingBodySchema,
	shippingOptionsBodySchema,
	topupBodySchema,
	yearEndCheckBodySchema,
} from '@/lib/accounting/posting-schema';
import { runAccountingPosting } from '@/lib/accounting/posting-runner';
import {
	assignDisputeConfirmed,
	checkYearEndShipment,
	getIntakeReconciliation,
	getShipmentJournalTrace,
	getShippingOptions,
	getStripeBalanceReconciliation,
	getStripeFeeReconciliation,
	getStripeInvoiceRecord,
	listCarrierDateGaps,
	listDeferredRevenue,
	listDeferredRevenueAnomalies,
	listDisputeSettings,
	listDisputes,
	listPendingEvents,
	listYearEndShipments,
	recordBalanceTopup,
	resolvePendingEvent,
	setDisputeSetting,
	setShippingOptions,
	setStripeInvoiceRecord,
} from '@/lib/accounting/posting-store';
import type { PermissionCode } from '@/lib/auth/admin-rbac';

// 計上待ち・計上係・支払いの取り消し・Stripe の記録・照合・年末の照合の route の本体。
// 読みは accounting-route の handleRead（admin.finance.read・全応答 no-store）、書きは handleAccountingWrite
// （認可 → CSRF → IP の制限 → actor の制限 → 入力 → store → 監査 → 応答）を使う。route ファイルは薄く保つ。

const label = (method: string, path: string): string => `${method} /api/admin/accounting/${path}`;
const invalid = (): AccountingStoreError => new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID');

const FINANCE_MANAGE: PermissionCode = 'admin.finance.manage';
const ENTRIES_CORRECT: PermissionCode = 'admin.accounting.entries.correct';

const queryOf = (request: Request): URLSearchParams => new URL(request.url).searchParams;

/** 続きの目印を付けた問い合わせを DB が 22023 で断るのは、目印が古い時だけ（ほかの入力は先に検査済み）。画面に最初から読み直させる。 */
async function withRestart<T>(hasCursor: boolean, load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (error) {
		if (hasCursor && error instanceof AccountingStoreError && error.code === 'ACCOUNTING_ARGUMENT_INVALID') {
			throw new AccountingListRestartError();
		}
		throw error;
	}
}

// ---- 計上待ち ----

/** 計上待ちの一覧。個人の情報は DB の読み口が持たない。 */
export function handlePendingEventsGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'pending-events'), async (client, req) => {
		const query = parsePendingEventsQuery(queryOf(req));
		if (!query) throw invalid();
		return withRestart(query.afterAt !== undefined, () => listPendingEvents(client, query));
	});
}

/** 確認済みにする。監査は対象の番号と結果だけ（メモの本文は入れない）。 */
export function handlePendingResolve(request: Request, context: AccountingContext): Promise<Response> {
	return handleAccountingWrite(request, context, {
		label: label('POST', 'pending-events/[id]/resolve'),
		action: 'admin.accounting.pending.resolve',
		permission: ENTRIES_CORRECT,
		withId: true,
		idKey: 'event_id',
		status: 200,
		schema: resolvePendingBodySchema,
		run: (client, actorId, id, body) => resolvePendingEvent(client, actorId, { eventId: id as string, note: body.note, requestKey: body.requestKey }),
		audit: (_result, id) => ({ resourceId: id, metadata: { event_id: id ?? undefined, result: 'resolved' } }),
		respond: async (_client, event) => ({ event }),
	});
}

/** 計上係を今すぐ流す。監査は件数だけ。 */
export function handlePostingRun(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('POST', 'posting/run'),
		action: 'admin.accounting.posting.run',
		permission: FINANCE_MANAGE,
		withId: false,
		status: 200,
		schema: runPostingBodySchema,
		run: (client) => runAccountingPosting(client),
		audit: (result) => ({
			resourceId: null,
			metadata: {
				counts: {
					payments: result.payments,
					shipments: result.shipments,
					stripe: result.stripe,
					disputes: result.disputes,
					parked: result.parked,
					resolved: result.resolved,
					has_more: result.hasMore,
				},
			},
		}),
		respond: async (_client, result) => ({ result }),
	});
}

// ---- 支払いの取り消し ----

export function handleDisputeSettingsGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'dispute-settings'), (client) => listDisputeSettings(client));
}

/** 原因ごとの振り替え先の科目。監査は原因と勘定の符号だけ（金額は載せない）。 */
export function handleDisputeSettingPut(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('PUT', 'dispute-settings'),
		action: 'admin.accounting.dispute.setting',
		withId: false,
		status: 200,
		schema: disputeSettingBodySchema,
		run: async (client, actorId, _id, body) => ({
			reason: body.reason,
			accountCode: body.accountCode,
			setting: await setDisputeSetting(client, actorId, body),
		}),
		audit: ({ reason, accountCode }) => ({ resourceId: null, metadata: { reason, account_code: accountCode } }),
		respond: async (_client, { setting }) => ({ setting }),
	});
}

export function handleDisputesGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'disputes'), async (client, req) => {
		const query = parseDisputesQuery(queryOf(req));
		if (!query) throw invalid();
		return withRestart(query.afterAt !== undefined, () => listDisputes(client, query));
	});
}

/** 確定・科目の決定待ちの振り替え。[id] は Stripe の dispute の番号（dp_…）。 */
export function handleDisputeAssign(request: Request, context: AccountingContext): Promise<Response> {
	return handleAccountingWrite(request, context, {
		label: label('POST', 'disputes/[id]/assign'),
		action: 'admin.accounting.dispute.assign',
		permission: ENTRIES_CORRECT,
		withId: true,
		idSchema: disputeIdSchema,
		idKey: 'dispute_id',
		status: 200,
		schema: assignDisputeBodySchema,
		run: (client, actorId, id, body) => assignDisputeConfirmed(client, actorId, { disputeId: id as string, requestKey: body.requestKey }),
		audit: (result, id) => ({
			resourceId: id,
			metadata: { dispute_id: id ?? undefined, result: result.created === false ? 'already_assigned' : 'assigned' },
		}),
		respond: async (_client, result) => ({ assignment: result }),
	});
}

// ---- Stripe の記録 ----

/** 月の適格請求書の記録（無ければ null）。 */
export function handleStripeInvoiceGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'stripe-invoices'), async (client, req) => {
		const query = parseInvoiceQuery(queryOf(req));
		if (!query) throw invalid();
		return { record: await getStripeInvoiceRecord(client, query.month) };
	});
}

/** 適格請求書の合計の記録（版つき）。監査は月と結果だけ（金額を入れない）。 */
export function handleStripeInvoicePut(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('PUT', 'stripe-invoices'),
		action: 'admin.accounting.stripe.invoice',
		permission: FINANCE_MANAGE,
		withId: false,
		status: 200,
		schema: invoiceBodySchema,
		run: async (client, actorId, _id, body) => ({ month: body.month, record: await setStripeInvoiceRecord(client, actorId, body) }),
		audit: ({ month }) => ({ resourceId: null, metadata: { month, result: 'saved' } }),
		respond: async (_client, { record }) => ({ record }),
	});
}

const BEFORE_CUTOVER_TEXT = '切り替えの日より前の日は入れられません。';

/** 残高の補充の記録（1-a14）。日は今日まで・切り替えの日以後。監査は結果だけ。 */
export function handleBalanceTopupPost(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('POST', 'balance-topups'),
		action: 'admin.accounting.stripe.topup',
		permission: FINANCE_MANAGE,
		withId: false,
		status: 200,
		schema: topupBodySchema(toJstDate(new Date())),
		run: async (client, actorId, _id, body) => {
			// DB は切り替えの日より前も他の誤りと同じ ACCOUNTING_ARGUMENT_INVALID で断るので、先に設定を読んで文を分ける。
			const settings = await getAccountingSettings(client);
			if (body.bankDate < settings.cutoverOn) {
				throw new AccountingStoreError('ACCOUNTING_ARGUMENT_INVALID', undefined, { message: BEFORE_CUTOVER_TEXT });
			}
			return recordBalanceTopup(client, actorId, body);
		},
		audit: (result) => ({ resourceId: null, metadata: { result: result.created === false ? 'replayed' : 'recorded' } }),
		respond: async (_client, result) => ({ topup: result }),
	});
}

// ---- 照合 ----

/** 3つの照合の読み口をそのまま返す（平らなオブジェクト。形は変えない）。 */
export function handleReconciliationGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'reconciliation'), async (client, req) => {
		const query = parseReconciliationQuery(queryOf(req));
		if (!query) throw invalid();
		switch (query.kind) {
			case 'stripe-balance':
				return getStripeBalanceReconciliation(client, query.through);
			case 'stripe-fee':
				return getStripeFeeReconciliation(client, query.month);
			case 'intake':
				return getIntakeReconciliation(client, { from: query.from, to: query.to });
		}
	});
}

/** 繰り越した前受金の一覧と異常の一覧。`asOf` を省くと今日（日本時間）。 */
export function handleDeferredRevenueGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'deferred-revenue'), async (client, req) => {
		const query = parseDeferredRevenueQuery(queryOf(req));
		if (!query) throw invalid();
		const asOf = query.asOf ?? toJstDate(new Date());
		const list = await withRestart(query.afterOrder !== undefined, () =>
			listDeferredRevenue(client, { asOf, limit: query.limit, afterOrder: query.afterOrder }),
		);
		const anomalies = await listDeferredRevenueAnomalies(client);
		return { ...list, anomalies: anomalies.anomalies ?? [] };
	});
}

// ---- 年末の照合 ----

/** 年末の発送票の一覧（確かめた印つき）、受付日とのずれ、設定。 */
export function handleYearEndGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'year-end-shipments'), async (client, req) => {
		const query = parseYearEndQuery(queryOf(req));
		if (!query) throw invalid();
		const list = await withRestart(query.afterDate !== undefined, () => listYearEndShipments(client, query));
		const options = await getShippingOptions(client);
		const gaps = await listCarrierDateGaps(client, { from: query.from, to: query.to, limit: query.limit });
		return { ...list, options, carrier_gaps: gaps };
	});
}

/** 確かめた印。監査は発送票の番号と結果だけ。 */
export function handleYearEndCheckPost(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('POST', 'year-end-shipments'),
		action: 'admin.accounting.year_end.check',
		permission: FINANCE_MANAGE,
		withId: false,
		status: 200,
		schema: yearEndCheckBodySchema,
		run: async (client, actorId, _id, body) => ({ slipId: body.slipId, check: await checkYearEndShipment(client, actorId, body) }),
		audit: ({ slipId, check }) => ({
			resourceId: slipId,
			metadata: { slip_id: slipId, result: check.created === false ? 'already_checked' : 'checked' },
		}),
		respond: async (_client, { check }) => ({ check }),
	});
}

/** 運送会社の受付日の照らし合わせのオン・オフ。監査は結果だけ。 */
export function handleYearEndOptionsPut(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: label('PUT', 'year-end-shipments'),
		action: 'admin.accounting.shipping.options',
		withId: false,
		status: 200,
		schema: shippingOptionsBodySchema,
		run: async (client, actorId, _id, body) => ({ enabled: body.carrierDateCheckEnabled, options: await setShippingOptions(client, actorId, body) }),
		audit: ({ enabled }) => ({ resourceId: null, metadata: { result: enabled ? 'enabled' : 'disabled' } }),
		respond: async (_client, { options }) => ({ options }),
	});
}

/** 発送票の直した跡と仕訳（6-b）。 */
export function handleShipmentTraceGet(request: Request): Promise<Response> {
	return handleRead(request, label('GET', 'shipment-trace'), async (client, req) => {
		const query = parseShipmentTraceQuery(queryOf(req));
		if (!query) throw invalid();
		return getShipmentJournalTrace(client, query.slipId);
	});
}
