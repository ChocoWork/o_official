import fs from 'node:fs';
import path from 'node:path';
import {
	STRIPE_CATEGORY_RULES,
	buildStripeCategoryKindSql,
	kindOfStripeCategory,
} from '@/lib/accounting/stripe-categories';

const directory = path.join(process.cwd(), 'supabase/migrations');
const s9Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_stripe_posting.sql'));
const s9 = s9Files.length === 1 ? fs.readFileSync(path.join(directory, s9Files[0]), 'utf8') : '';
const s9Map = s9.split('-- ACC_S9_CATEGORY_MAP_BEGIN\n')[1]?.split('-- ACC_S9_CATEGORY_MAP_END')[0] ?? '';

describe('FREQ-565-AC-03: Stripe の取引の種類の対応は type を鍵にする', () => {
	it.each([
		['charge', 'charge', 'sale'],
		['payment', 'charge', 'sale'],
		['refund', 'refund', 'refund_principal'],
		['payment_refund', 'refund', 'refund_principal'],
		['refund_failure', 'refund_failure', 'refund_principal'],
		['stripe_fee', 'fee', 'fee_only'],
		['stripe_fx_fee', 'fee', 'fee_only'],
		['tax_fee', 'tax', 'tax_adjustment'],
		['payout', 'payout', 'payout'],
		['payout_failure', 'payout_reversal', 'payout_failure'],
		['payout_cancel', 'payout_reversal', 'payout_failure'],
		['adjustment', 'dispute', 'dispute'],
		['adjustment', 'dispute_reversal', 'dispute'],
		['topup', 'topup', 'manual_topup'],
		['topup_reversal', 'topup', 'manual_topup'],
	])('type=%s reporting_category=%s は %s', (type, reportingCategory, kind) => {
		expect(kindOfStripeCategory(type, reportingCategory)).toBe(kind);
	});

	it('reporting_category が違っても type が決める種類は同じ（補助でしかない）', () => {
		expect(kindOfStripeCategory('stripe_fee', 'anything')).toBe('fee_only');
		expect(kindOfStripeCategory('payout_failure', 'anything')).toBe('payout_failure');
		expect(kindOfStripeCategory('refund', 'anything')).toBe('refund_principal');
	});

	it('支払いは reporting_category が charge の時だけ売上。ほかは知らない種類（どの係からも落ちない）', () => {
		expect(kindOfStripeCategory('charge', 'other_charge')).toBeNull();
		expect(kindOfStripeCategory('payment', 'network_cost')).toBeNull();
		expect(kindOfStripeCategory('adjustment', 'other_adjustment')).toBeNull();
	});

	it('知らない type は null（黙って捨てず unknown_category で止まる）', () => {
		expect(kindOfStripeCategory('advance', 'advance')).toBeNull();
		expect(kindOfStripeCategory('', '')).toBeNull();
	});

	it('どの type も2つの規則に入らない', () => {
		const owners = new Map<string, string>();
		for (const rule of STRIPE_CATEGORY_RULES) {
			for (const type of rule.types) {
				const previous = owners.get(`${type}`);
				// adjustment と charge は reporting_category で絞るので、同じ type を別の kind が取り合わない。
				expect(previous).toBeUndefined();
				owners.set(type, rule.kind);
			}
		}
	});
});

describe('FREQ-565-AC-03: 種類の対応はTSとSQLで一致する', () => {
	it('移行 S9 の `ACC_S9_CATEGORY_MAP` の間は、TS の表から出した全文と1字も違わない', () => {
		expect(s9Map).not.toBe('');
		expect(s9Map).toBe(buildStripeCategoryKindSql());
	});

	it('出した SQL は IMMUTABLE の SQL 関数で、ASCII だけ', () => {
		const sql = buildStripeCategoryKindSql();
		expect(sql).toMatch(/LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''/);
		expect(sql).toMatch(/^[\x20-\x7e\n]*$/);
		for (const rule of STRIPE_CATEGORY_RULES) expect(sql).toContain(`THEN '${rule.kind}'`);
	});
});
