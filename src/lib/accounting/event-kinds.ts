// 仕訳を作る出来事の種類（設計 1-a01〜1-a22 の全部、27種）と、印に使う番号の個数。
// SQL の private.accounting_event_kinds() と同じ一覧を持つ（Task 6 の試験で突き合わせる）。

export const ACCOUNTING_EVENT_KINDS = [
	'payment_confirmed',
	'shipment_confirmed',
	'shipment_redated',
	'pre_shipment_refund',
	'return_arrived',
	'return_amount_decided',
	'return_refund',
	'refund_failed',
	'refund_abandoned',
	'stripe_fee',
	'stripe_tax_adjustment',
	'payout_started',
	'bank_arrived',
	'payout_failed',
	'balance_topup',
	'dispute_event',
	'dispute_withdrawn_late',
	'exchange_movement',
	'owner_use',
	'personal_discount',
	'compensation_received',
	'manual_entry',
	'migrated_entry',
	'period_closing_entry',
	'closed_year_correction',
	'return_arrival_redated',
	'reversal',
] as const;

export type AccountingEventKind = (typeof ACCOUNTING_EVENT_KINDS)[number];

/** 印に使う番号の個数。 */
export const EVENT_KEY_ARITY: Readonly<Record<AccountingEventKind, number>> = {
	payment_confirmed: 1,
	shipment_confirmed: 1,
	shipment_redated: 1,
	pre_shipment_refund: 1,
	return_arrived: 1,
	return_amount_decided: 1,
	return_refund: 1,
	refund_failed: 2,
	refund_abandoned: 2,
	stripe_fee: 1,
	stripe_tax_adjustment: 1,
	payout_started: 1,
	bank_arrived: 1,
	payout_failed: 1,
	balance_topup: 1,
	dispute_event: 3,
	dispute_withdrawn_late: 2,
	exchange_movement: 1,
	owner_use: 1,
	personal_discount: 2,
	compensation_received: 1,
	manual_entry: 2,
	migrated_entry: 1,
	period_closing_entry: 3,
	closed_year_correction: 3,
	return_arrival_redated: 1,
	reversal: 1,
};

/** 印の前置き。種類の名前を使い、stripe_fee だけ設計 1-a10 の形 stripe:fee にそろえる。 */
export const EVENT_KEY_PREFIX: Readonly<Record<AccountingEventKind, string>> = Object.fromEntries(
	ACCOUNTING_EVENT_KINDS.map((kind) => [kind, kind === 'stripe_fee' ? 'stripe:fee' : kind]),
) as Record<AccountingEventKind, string>;

export function isAccountingEventKind(value: string): value is AccountingEventKind {
	return Object.prototype.hasOwnProperty.call(EVENT_KEY_ARITY, value);
}
