// 返品の届いた日・配達日の設定・返金の取り消しの区分・振込の記録・結び・消費税用の返金の一覧の route が受ける
// 本文と問い合わせの検査（I/O なし。計画3 Task 10）。

import { z } from 'zod';
import { isoDateSchema, uuidSchema, versionSchema } from '@/lib/accounting/accounting-schema';
import { parseQuery } from '@/lib/accounting/posting-schema';
import {
	BANK_TXN_NO_PATTERN,
	MAX_ARRIVAL_REASON,
	MAX_REFUND_BANK_NOTE,
	MAX_REFUND_DECISION_REASON,
	MAX_TAX_REFUND_PAGE,
} from '@/lib/accounting/return-refund-types';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** 届いた日の問い合わせで一度に引ける受け取りの数（DB の get_return_arrival_info と同じ）。 */
export const MAX_ARRIVAL_RECEIPTS = 200;
export const MAX_REFUND_STATE_PAGE = 100;
export const DEFAULT_REFUND_STATE_PAGE = 50;
export const DEFAULT_TAX_REFUND_PAGE = 100;
/** 消費税用の一覧で一度に引ける期間（月）。 */
export const MAX_TAX_REFUND_MONTHS = 12;

const monthSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value));
const positiveInt = (max: number) =>
	z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).pipe(z.number().int().min(1).max(max));
/** order_return_arrival_corrections.version（integer）。 */
const arrivalVersionSchema = z.number().int().min(0).max(2147483647);

// ---- 届いた日 ----

const arrivalQuerySchema = z
	.object({ receiptIds: z.string().min(1) })
	.strict()
	.transform((q) => q.receiptIds.split(','))
	.pipe(
		z
			.array(uuidSchema)
			.min(1)
			.max(MAX_ARRIVAL_RECEIPTS)
			.refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length),
	);

/** `receiptIds` はコンマ区切りの受け取りの番号（1〜200件・重複なし）。 */
export const parseReturnArrivalQuery = (params: URLSearchParams): string[] | null => parseQuery(params, arrivalQuerySchema);

/** 理由の本文と日は監査に入れない。DB は前後の空白を落とした長さを確かめる。 */
export const correctArrivalBodySchema = z
	.object({
		receiptId: uuidSchema,
		newOn: isoDateSchema,
		reason: z.string().trim().min(1).max(MAX_ARRIVAL_REASON),
		expectedVersion: arrivalVersionSchema,
		requestKey: uuidSchema,
	})
	.strict();
export type CorrectArrivalBody = z.infer<typeof correctArrivalBodySchema>;

/** 受け取りの route の `arrivedOn`（YYYY-MM-DD。暦にある日だけ。未来・申し込みの前・確定済みは DB が断る）。 */
export const arrivedOnSchema = isoDateSchema;

export const returnOptionBodySchema = z
	.object({ enabled: z.boolean(), expectedVersion: versionSchema, requestKey: uuidSchema })
	.strict();
export type ReturnOptionBody = z.infer<typeof returnOptionBodySchema>;

// ---- 返金の状態 ----

const refundStatesQuerySchema = z
	.object({ limit: positiveInt(MAX_REFUND_STATE_PAGE).optional(), afterAt: timestampSchema.optional(), afterId: uuidSchema.optional() })
	.strict()
	.refine((q) => (q.afterAt === undefined) === (q.afterId === undefined))
	.transform((q) => ({
		limit: q.limit ?? DEFAULT_REFUND_STATE_PAGE,
		...(q.afterAt !== undefined && q.afterId !== undefined ? { afterAt: q.afterAt, afterId: q.afterId } : {}),
	}));
export type RefundStatesQuery = z.output<typeof refundStatesQuerySchema>;
export const parseRefundStatesQuery = (params: URLSearchParams): RefundStatesQuery | null => parseQuery(params, refundStatesQuerySchema);

/** 理由の本文は DB に渡すだけで、監査にも応答にも入れない。 */
export const refundCancellationBodySchema = z
	.object({
		refundId: uuidSchema,
		kind: z.enum(['abandoned', 'owed']),
		reason: z.string().trim().min(1).max(MAX_REFUND_DECISION_REASON),
		requestKey: uuidSchema,
	})
	.strict();
export type RefundCancellationBody = z.infer<typeof refundCancellationBodySchema>;

/** 振込の日は今日（日本時間）まで。切り替えの日より前・確定済みの取り消しの日以前は DB が断る。 */
export function refundBankTransferBodySchema(todayJst: string) {
	return z
		.object({
			orderId: uuidSchema,
			origin: z.enum(['pre_shipment', 'post_shipment', 'return']),
			amount: z.number().int().min(1).max(MAX_SAFE),
			bankDate: isoDateSchema.refine((date) => date <= todayJst),
			bankTxnNo: z.string().trim().regex(BANK_TXN_NO_PATTERN),
			note: z
				.string()
				.trim()
				.max(MAX_REFUND_BANK_NOTE)
				.transform((value) => (value === '' ? null : value))
				.nullable(),
			requestKey: uuidSchema,
		})
		.strict();
}
export type RefundBankTransferBody = z.infer<ReturnType<typeof refundBankTransferBodySchema>>;

export const refundSettlementBodySchema = z
	.object({ owedRefundId: uuidSchema, payingRefundId: uuidSchema, requestKey: uuidSchema })
	.strict()
	.refine((b) => b.owedRefundId.toLowerCase() !== b.payingRefundId.toLowerCase());
export type RefundSettlementBody = z.infer<typeof refundSettlementBodySchema>;

// ---- 消費税用の返金の一覧 ----

/** 一覧の行の印: `<仕訳の番号>:<行の番号>`（DB の line_key と同じ形）。 */
export const TAX_REFUND_LINE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,8}$/;

function monthStart(month: string): string {
	return `${month}-01`;
}
function monthEnd(month: string): string {
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	return `${month}-${String(last).padStart(2, '0')}`;
}
function monthsBetween(from: string, to: string): number {
	return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
}

const taxRefundsQuerySchema = z
	.object({
		from: monthSchema,
		to: monthSchema,
		limit: positiveInt(MAX_TAX_REFUND_PAGE).optional(),
		afterDate: isoDateSchema.optional(),
		afterKey: z.string().regex(TAX_REFUND_LINE_KEY_PATTERN).optional(),
	})
	.strict()
	.refine((q) => q.from <= q.to && monthsBetween(q.from, q.to) <= MAX_TAX_REFUND_MONTHS)
	.refine((q) => (q.afterDate === undefined) === (q.afterKey === undefined))
	.transform((q) => ({
		from: monthStart(q.from),
		to: monthEnd(q.to),
		limit: q.limit ?? DEFAULT_TAX_REFUND_PAGE,
		...(q.afterDate !== undefined && q.afterKey !== undefined ? { afterDate: q.afterDate, afterKey: q.afterKey } : {}),
	}));
export type TaxRefundsQuery = z.output<typeof taxRefundsQuerySchema>;

/** `from`・`to` は月（YYYY-MM、最大12か月）。DB へは月の初日と末日で渡す。続きの目印は日と行の印の両方か、どちらも無し。 */
export const parseTaxRefundsQuery = (params: URLSearchParams): TaxRefundsQuery | null => parseQuery(params, taxRefundsQuerySchema);
