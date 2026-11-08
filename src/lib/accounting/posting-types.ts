// 計上待ちと計上係の型・上限（計画2の「共通の型・値・拒否」）。
// PENDING_REASONS は SQL の public.accounting_pending_events の reason の CHECK と同じ一覧を同じ順で持つ（試験で突き合わせる）。

import type { AccountingEventKind } from '@/lib/accounting/event-kinds';

export const PENDING_REASONS = [
	'payment_journal_missing',
	'order_not_postable',
	'amount_mismatch',
	'no_order',
	'units_insufficient',
	'shipment_date_mismatch',
	'deferred_revenue_short',
	'period_missing',
	'posting_error',
	'before_cutover',
	'unknown_category',
	'payout_mismatch',
	'dispute_refund_overlap',
	'dispute_return_refund_pending',
	'dispute_withdrawal_missing',
	'dispute_shipment_pending',
	'shipment_lines_mismatch',
	'no_revenue',
] as const;

export type PendingReason = (typeof PENDING_REASONS)[number];

/** 止めの理由ごとに決めた固定の鍵だけを持つ。個人の情報や生の例外の文は入れない。 */
export type PendingDetail = Record<string, string | number | boolean | null>;

export type PendingEvent = {
	id: string;
	eventKind: AccountingEventKind;
	sourceTable: string;
	sourceId: string;
	orderId: string | null;
	reason: PendingReason;
	detail: PendingDetail;
	firstDetectedAt: string;
	lastDetectedAt: string;
	detectionCount: number;
	resolvedAt: string | null;
	resolvedEntryId: string | null;
};

/** `accounting_run_posting` の戻りの jsonb（snake_case）を store が直した形。 */
export type PostingRunResult = {
	payments: number;
	shipments: number;
	stripe: number;
	disputes: number;
	parked: number;
	resolved: number;
	hasMore: boolean;
};

export const DEFAULT_POSTING_BATCH = 50;
export const MAX_POSTING_BATCH = 200;
export const MAX_POSTING_LOOPS = 20;
export const MAX_PENDING_PAGE = 100;
export const MAX_DISPUTE_NOTE = 500;
