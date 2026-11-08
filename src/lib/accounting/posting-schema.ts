// 計上待ち・支払いの取り消し・Stripe の記録・照合・年末の照合の route が受ける本文と問い合わせの検査（I/O なし）。

import { z } from 'zod';
import { isoDateSchema, uuidSchema, versionSchema } from '@/lib/accounting/accounting-schema';
import { MAX_PENDING_PAGE } from '@/lib/accounting/posting-types';

/** 支払いの取り消しの原因（Stripe の dispute の reason）。振り替え先の設定の鍵。知らない値は `other` 扱いで、設定の鍵には使えない。 */
export const DISPUTE_CAUSES = [
	'fraudulent',
	'product_not_received',
	'product_unacceptable',
	'unrecognized',
	'duplicate',
	'subscription_canceled',
	'credit_not_processed',
	'general',
	'bank_cannot_process',
	'check_returned',
	'customer_initiated',
	'debit_not_authorized',
	'incorrect_account_details',
	'insufficient_funds',
	'noncompliant',
	'other',
] as const;

export const MAX_RESOLUTION_NOTE = 500;
export const MAX_TOPUP_NOTE = 400;
export const MAX_SHIPMENT_CHECK_NOTE = 200;
export const MAX_INVOICE_REF = 200;
/** 年末の一覧・受付日の照合の範囲は最大60日（DB と同じ）。 */
export const MAX_YEAR_END_DAYS = 59;
export const MAX_YEAR_END_PAGE = 200;
export const DEFAULT_YEAR_END_PAGE = 100;
export const MAX_DEFERRED_PAGE = 200;
export const DEFAULT_DEFERRED_PAGE = 100;
export const DEFAULT_PENDING_PAGE = 50;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** 銀行の取引の番号・Stripe の取引の番号。DB と同じ形（Ruling P2-M6）。 */
export const TOPUP_REFERENCE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
export const DISPUTE_ID_PATTERN = /^dp_[A-Za-z0-9]+$/;

export const disputeCauseSchema = z.enum(DISPUTE_CAUSES);
export const disputeIdSchema = z.string().regex(DISPUTE_ID_PATTERN);
const accountCodeSchema = z.string().regex(/^[0-9]{4}$/);
const monthSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value));
const yenSchema = z.number().int().min(0).max(MAX_SAFE);
const positiveYenSchema = z.number().int().min(1).max(MAX_SAFE);

const positiveInt = (max: number) =>
	z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).pipe(z.number().int().min(1).max(max));

/** 同じ鍵を重ねた問い合わせは断る（null）。知らない鍵は `.strict()` が断る。 */
export function parseQuery<T>(params: URLSearchParams, schema: z.ZodType<T>): T | null {
	const raw: Record<string, string> = {};
	for (const [key, value] of params) {
		if (Object.hasOwn(raw, key)) return null;
		raw[key] = value;
	}
	const parsed = schema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

const pendingQuerySchema = z
	.object({
		includeResolved: z.enum(['true', 'false']).optional(),
		limit: positiveInt(MAX_PENDING_PAGE).optional(),
		afterAt: timestampSchema.optional(),
		afterId: uuidSchema.optional(),
	})
	.strict()
	.refine((q) => (q.afterAt === undefined) === (q.afterId === undefined))
	.transform((q) => ({
		includeResolved: q.includeResolved === 'true',
		limit: q.limit ?? DEFAULT_PENDING_PAGE,
		...(q.afterAt !== undefined && q.afterId !== undefined ? { afterAt: q.afterAt, afterId: q.afterId } : {}),
	}));
export type PendingEventsQuery = z.output<typeof pendingQuerySchema>;
export const parsePendingEventsQuery = (params: URLSearchParams): PendingEventsQuery | null => parseQuery(params, pendingQuerySchema);

/** メモの本文は監査に入れない。DB は前後の空白を落とした長さを確かめる。 */
export const resolvePendingBodySchema = z
	.object({ note: z.string().trim().min(1).max(MAX_RESOLUTION_NOTE), requestKey: uuidSchema })
	.strict();
export type ResolvePendingBody = z.infer<typeof resolvePendingBodySchema>;

/** 計上係を今すぐ流す。入力は無い（本文なしか空の `{}`）。 */
export const runPostingBodySchema = z.union([z.object({}).strict(), z.null()]);

export const disputeSettingBodySchema = z
	.object({
		reason: disputeCauseSchema,
		accountCode: accountCodeSchema,
		/** 初めて入れる時は null、変える時は読んだ版。 */
		expectedVersion: versionSchema.nullable(),
		requestKey: uuidSchema,
	})
	.strict();
export type DisputeSettingBody = z.infer<typeof disputeSettingBodySchema>;

const disputesQuerySchema = z
	.object({
		limit: positiveInt(MAX_PENDING_PAGE).optional(),
		afterAt: timestampSchema.optional(),
		afterId: disputeIdSchema.optional(),
	})
	.strict()
	.refine((q) => (q.afterAt === undefined) === (q.afterId === undefined))
	.transform((q) => ({
		limit: q.limit ?? DEFAULT_PENDING_PAGE,
		...(q.afterAt !== undefined && q.afterId !== undefined ? { afterAt: q.afterAt, afterId: q.afterId } : {}),
	}));
export type DisputesQuery = z.output<typeof disputesQuerySchema>;
export const parseDisputesQuery = (params: URLSearchParams): DisputesQuery | null => parseQuery(params, disputesQuerySchema);

export const assignDisputeBodySchema = z.object({ requestKey: uuidSchema }).strict();
export type AssignDisputeBody = z.infer<typeof assignDisputeBodySchema>;

export const invoiceQuerySchema = z.object({ month: monthSchema }).strict();
export const parseInvoiceQuery = (params: URLSearchParams): { month: string } | null => parseQuery(params, invoiceQuerySchema);

export const invoiceBodySchema = z
	.object({
		month: monthSchema,
		total: yenSchema,
		tax: yenSchema,
		documentRef: z.string().trim().max(MAX_INVOICE_REF).nullable(),
		/** 初めて入れる月は null、直す時は読んだ版。 */
		expectedVersion: versionSchema.nullable(),
		requestKey: uuidSchema,
	})
	.strict();
export type InvoiceBody = z.infer<typeof invoiceBodySchema>;

/** 補充の日は今日（日本時間）まで。切り替えの日より前かどうかは store が設定を読んで確かめる。 */
export function topupBodySchema(todayJst: string) {
	return z
		.object({
			amount: positiveYenSchema,
			bankDate: isoDateSchema.refine((date) => date <= todayJst),
			bankTxnNo: z.string().trim().regex(TOPUP_REFERENCE_PATTERN).nullable(),
			stripeTxnId: z.string().trim().regex(TOPUP_REFERENCE_PATTERN).nullable(),
			note: z.string().trim().max(MAX_TOPUP_NOTE).nullable(),
			requestKey: uuidSchema,
		})
		.strict()
		.refine((b) => b.bankTxnNo !== null || b.stripeTxnId !== null);
}
export type TopupBody = z.infer<ReturnType<typeof topupBodySchema>>;

const stripeBalanceQuery = z.object({ kind: z.literal('stripe-balance'), through: isoDateSchema }).strict();
const stripeFeeQuery = z.object({ kind: z.literal('stripe-fee'), month: monthSchema }).strict();
const intakeQuery = z
	.object({ kind: z.literal('intake'), from: isoDateSchema, to: isoDateSchema })
	.strict()
	.refine((q) => q.from <= q.to);
const reconciliationQuerySchema = z.discriminatedUnion('kind', [stripeBalanceQuery, stripeFeeQuery, intakeQuery]);
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
export const parseReconciliationQuery = (params: URLSearchParams): ReconciliationQuery | null =>
	parseQuery(params, reconciliationQuerySchema);

const deferredQuerySchema = z
	.object({ asOf: isoDateSchema.optional(), limit: positiveInt(MAX_DEFERRED_PAGE).optional(), afterOrder: uuidSchema.optional() })
	.strict()
	.transform((q) => ({
		...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
		limit: q.limit ?? DEFAULT_DEFERRED_PAGE,
		...(q.afterOrder !== undefined ? { afterOrder: q.afterOrder } : {}),
	}));
export type DeferredRevenueQuery = z.output<typeof deferredQuerySchema>;
export const parseDeferredRevenueQuery = (params: URLSearchParams): DeferredRevenueQuery | null =>
	parseQuery(params, deferredQuerySchema);

function daysBetween(from: string, to: string): number {
	return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

const yearEndQuerySchema = z
	.object({
		from: isoDateSchema,
		to: isoDateSchema,
		limit: positiveInt(MAX_YEAR_END_PAGE).optional(),
		afterDate: isoDateSchema.optional(),
		afterSlip: uuidSchema.optional(),
	})
	.strict()
	.refine((q) => q.from <= q.to && daysBetween(q.from, q.to) <= MAX_YEAR_END_DAYS)
	.refine((q) => (q.afterDate === undefined) === (q.afterSlip === undefined))
	.transform((q) => ({
		from: q.from,
		to: q.to,
		limit: q.limit ?? DEFAULT_YEAR_END_PAGE,
		...(q.afterDate !== undefined && q.afterSlip !== undefined ? { afterDate: q.afterDate, afterSlip: q.afterSlip } : {}),
	}));
export type YearEndQuery = z.output<typeof yearEndQuerySchema>;
export const parseYearEndQuery = (params: URLSearchParams): YearEndQuery | null => parseQuery(params, yearEndQuerySchema);

export const yearEndCheckBodySchema = z
	.object({ slipId: uuidSchema, note: z.string().trim().max(MAX_SHIPMENT_CHECK_NOTE).nullable(), requestKey: uuidSchema })
	.strict();
export type YearEndCheckBody = z.infer<typeof yearEndCheckBodySchema>;

export const shippingOptionsBodySchema = z
	.object({ carrierDateCheckEnabled: z.boolean(), expectedVersion: versionSchema, requestKey: uuidSchema })
	.strict();
export type ShippingOptionsBody = z.infer<typeof shippingOptionsBodySchema>;

export const shipmentTraceQuerySchema = z.object({ slipId: uuidSchema }).strict();
export const parseShipmentTraceQuery = (params: URLSearchParams): { slipId: string } | null =>
	parseQuery(params, shipmentTraceQuerySchema);
