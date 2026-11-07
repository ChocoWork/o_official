import {
	ACCOUNTING_EVENT_KINDS,
	EVENT_KEY_ARITY,
	EVENT_KEY_PREFIX,
	type AccountingEventKind,
} from '@/lib/accounting/event-kinds';
import { AccountingEventKeyError, buildEventKey, parseEventKey } from '@/lib/accounting/event-key';

const EXPECTED_ARITY: Record<AccountingEventKind, number> = {
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

describe('FREQ-554-AC-03: 印は種類と番号の組で作り個数と文字を検査する', () => {
	it('27種の種類と個数は計画の表と一致する', () => {
		expect(ACCOUNTING_EVENT_KINDS).toHaveLength(27);
		expect(new Set(ACCOUNTING_EVENT_KINDS).size).toBe(27);
		expect(EVENT_KEY_ARITY).toEqual(EXPECTED_ARITY);
	});

	it.each(ACCOUNTING_EVENT_KINDS.map((kind) => [kind]))('%s は arity どおりの番号で印を作り、読み戻せる', (kind) => {
		const parts = Array.from({ length: EXPECTED_ARITY[kind] }, (_, index) => `id_${index}.A-${index}`);
		const key = buildEventKey(kind, parts);
		expect(key).toBe(`${EVENT_KEY_PREFIX[kind]}:${parts.join(':')}`);
		expect(parseEventKey(key)).toEqual({ kind, parts });
	});

	it('stripe_fee の印は設計 1-a10 の形 stripe:fee:<番号> になる', () => {
		expect(buildEventKey('stripe_fee', ['txn_1'])).toBe('stripe:fee:txn_1');
		expect(parseEventKey('stripe:fee:txn_1')).toEqual({ kind: 'stripe_fee', parts: ['txn_1'] });
	});

	it('前置きは種類ごとに重ならない', () => {
		const prefixes = ACCOUNTING_EVENT_KINDS.map((kind) => EVENT_KEY_PREFIX[kind]);
		expect(new Set(prefixes).size).toBe(27);
		for (const kind of ACCOUNTING_EVENT_KINDS) {
			expect(EVENT_KEY_PREFIX[kind]).toBe(kind === 'stripe_fee' ? 'stripe:fee' : kind);
		}
	});

	it('個数違いを拒否する', () => {
		expect(() => buildEventKey('payment_confirmed', [])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('payment_confirmed', ['pi_1', 'pi_2'])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('dispute_event', ['dp_1', 'lost'])).toThrow(AccountingEventKeyError);
	});

	it(': を含む要素・空・129字・許されない文字を拒否する', () => {
		expect(() => buildEventKey('payment_confirmed', ['pi:1'])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('payment_confirmed', [''])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('payment_confirmed', ['a'.repeat(129)])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('payment_confirmed', ['a b'])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('payment_confirmed', ['売上'])).toThrow(AccountingEventKeyError);
		expect(buildEventKey('payment_confirmed', ['a'.repeat(128)])).toBe(`payment_confirmed:${'a'.repeat(128)}`);
	});

	it('一覧に無い種類を拒否する', () => {
		expect(() => buildEventKey('unknown_kind' as AccountingEventKind, ['x'])).toThrow(AccountingEventKeyError);
		expect(() => buildEventKey('stripe' as AccountingEventKind, ['fee', 'x'])).toThrow(AccountingEventKeyError);
	});

	it('形の合わない印は読まずに null を返す', () => {
		expect(parseEventKey('unknown_kind:x')).toBeNull();
		expect(parseEventKey('payment_confirmed')).toBeNull();
		expect(parseEventKey('payment_confirmed:')).toBeNull();
		expect(parseEventKey('payment_confirmed:a:b')).toBeNull();
		expect(parseEventKey('stripe_fee:txn_1')).toBeNull();
		expect(parseEventKey('stripe:fee')).toBeNull();
		expect(parseEventKey('manual_entry:12')).toBeNull();
		expect(parseEventKey('payment_confirmed:a b')).toBeNull();
	});

	it('違う種類と番号の組から同じ印は作られない', () => {
		const keys = new Set<string>();
		let count = 0;
		for (const kind of ACCOUNTING_EVENT_KINDS) {
			for (const seed of ['1', '2', 'x_y']) {
				keys.add(buildEventKey(kind, Array.from({ length: EXPECTED_ARITY[kind] }, (_, i) => `${seed}${i}`)));
				count += 1;
			}
		}
		expect(keys.size).toBe(count);
	});
});
