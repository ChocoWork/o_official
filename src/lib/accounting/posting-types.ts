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

/**
 * `accounting_run_posting` の戻りの jsonb（snake_case）を store が直した形。数は SQL が返した値のまま持つ。
 * - `payments`・`shipments`・`stripe`・`disputes`: 入れた仕訳の数（その係が新しく入れた物。取り消しや日の直しの仕訳も含む）。
 * - `parked`: 止めた件数（新しく止めた物と、見直して止め直した物の合計）。入れた直後に解決済みにする `no_revenue` の行も
 *   ここに数える（交換の品だけの発送票など）。
 * - `resolved`: 計上待ちが解決済みになった件数。額が0になる出荷など、仕訳を作らずに解決した物は `resolved` にだけ現れ、
 *   `shipments` には数えない。
 * - `hasMore`: 係の1回の件数の上限に達した（まだ新しい出来事が残りうる）。runner は `hasMore` が偽になるまで繰り返す。
 * 繰り返した時の数は回ごとの合計で、`hasMore` は最後の回の値（上限の回数で止まった時は真のまま）。
 */
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

/** 係を呼ぶ入口の名前。ログと監査に残す（個人の情報ではない）。 */
export type PostingSource =
	| 'webhook'
	| 'shipment_confirm'
	| 'shipment_cancel'
	| 'shipment_date'
	| 'bank_confirm'
	| 'reconcile'
	| 'cron'
	| 'manual';

/** 計上待ちの一覧の1ページ。`byReason` は未解決の理由ごとの件数。 */
export type PendingEventsPage = {
	events: PendingEvent[];
	nextAfterAt: string | null;
	nextAfterId: string | null;
	openCount: number;
	byReason: Partial<Record<PendingReason, number>>;
};

/** 発送票の確定の前に読む、その票の注文を止めている取り消しの有無。 */
export type SlipDisputeHold = { orderId: string; disputeId: string };
