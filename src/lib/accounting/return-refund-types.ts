// 返金・返品の事実の型（計画3の「共通の型・値・拒否」）。
// REFUND_EVENT_STATES・REFUND_FACT_EVENT_KINDS・RETURN_FACT_KINDS は、移行 S15 の CHECK と同じ一覧を同じ順で持つ
// （試験で突き合わせる）。

/** 返金の状態の履歴（public.accounting_refund_events.state）。同じ返金に同じ状態は1行まで。 */
export const REFUND_EVENT_STATES = [
	'requested',
	'accepted',
	'succeeded',
	'failed',
	'canceled',
	/** 取り消しの区分: 店が返金をやめた（理由・人・要求番号つき）。 */
	'abandoned',
	/** 取り消しの区分: 店は返すつもりのまま返せなかった（理由・人・要求番号つき）。 */
	'owed',
	'error',
	/** やり直しの結び（やり直しの返金に残す）。 */
	'settled',
] as const;

export type RefundEventState = (typeof REFUND_EVENT_STATES)[number];

/** 返金の始まりの元（public.order_refunds.source の8つ）。legacy の古い返金は事実を作らない。 */
export type RefundFactSource =
	| 'admin'
	| 'order_cancel'
	| 'return'
	| 'auto_cancelled_order_payment'
	| 'auto_amount_mismatch'
	| 'stripe_dashboard'
	| 'legacy'
	| 'unit_hold_release';

/**
 * 交換の設計の出来事への結び（public.accounting_refund_facts.event_kind）。出来事の kind との対応は
 * pre_shipment_cancel ↔ pre_shipment_cancel、return_receipt ↔ return_receive、holdback_release ↔ hold_release。
 */
export const REFUND_FACT_EVENT_KINDS = ['none', 'pre_shipment_cancel', 'return_receipt', 'holdback_release'] as const;

export type RefundFactEventKind = (typeof REFUND_FACT_EVENT_KINDS)[number];

/** 返金を始める時に1回だけ残す事実。残る着の値段の直しの差 d は持たない（accounting_refund_transfer_adjusts）。 */
export type RefundFacts = {
	refundId: string;
	orderId: string;
	source: RefundFactSource;
	returnId: string | null;
	/** order_unit_events.id（結び付かない返金は null）。 */
	eventId: string | null;
	eventKind: RefundFactEventKind;
	preShipmentAmount: number;
	postShipmentAmount: number;
	shippingAmount: number;
	/** 前の注文から差し引いた分を返す出来事の手数料だけ（ほかは0）。 */
	feeAmount: number;
	startedAt: string;
};

/** 返品の事実の種類（public.accounting_return_facts.kind）: 届いた日と、返金の額の決定。 */
export const RETURN_FACT_KINDS = ['arrival', 'decision'] as const;

export type ReturnFactKind = (typeof RETURN_FACT_KINDS)[number];

export type ReturnArrivalFact = {
	kind: 'arrival';
	receiptId: string;
	goodsAmount: number;
	feeAmount: number;
};

/**
 * 返金の額の決定。refundId が null の時は返金を0円で終える決定で、receiptId がある。refundId がある時の receiptId は、
 * 受け取りの道で返金を始めた時だけその受け取り。
 */
export type ReturnDecisionFact = {
	kind: 'decision';
	refundId: string | null;
	receiptId: string | null;
	coversAmount: number;
	feeAmount: number;
	decidedAmount: number;
	payableDelta: number;
	decidedOn: string;
};

/** 届いた日の直しの理由の字数の上限（order_return_arrival_corrections_reason_check と同じ）。 */
export const MAX_ARRIVAL_REASON = 500;

/** 返金の振込の記録のメモの字数の上限（DB の admin_record_refund_bank_transfer と同じ）。 */
export const MAX_REFUND_BANK_NOTE = 500;
/** 銀行の取引の番号。DB と同じ形（preflight #11）。 */
export const MAX_BANK_TXN_NO = 100;
export const BANK_TXN_NO_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** 消費税用の返金の一覧の1ページの上限（DB と同じ）。 */
export const MAX_TAX_REFUND_PAGE = 200;
/** 取り消しの区分・結びの理由の字数の上限（DB と同じ）。 */
export const MAX_REFUND_DECISION_REASON = 500;
