// Stripe の残高の取引の「種類」と、会計の係の扱いの対応（計画2 Task 4。設計 4-c・4-c4・1-a10〜1-a14）。
// 鍵は `type`。`reporting_category` は補助で、支払い（charge・payment）と支払いの取り消し（adjustment）だけが見る。
// SQL の `private.accounting_stripe_category_kind(_type text, _reporting_category text)` の本文は
// scripts/accounting/emit-stripe-categories.ts がこの表から出し、移行の本文へ貼る（試験が一致を確かめる）。

export type StripeCategoryKind =
	| 'sale'
	| 'refund_principal'
	| 'fee_only'
	| 'tax_adjustment'
	| 'payout'
	| 'payout_failure'
	| 'dispute'
	| 'manual_topup';

export type StripeCategoryRule = {
	kind: StripeCategoryKind;
	/** 残高の取引の `type`。 */
	types: readonly string[];
	/** 与えた時だけ、`reporting_category` がこの中の1つでなければ当てはまらない。 */
	reportingCategories?: readonly string[];
};

/**
 * 上から順に当てはめる。どれにも当たらない取引は null（`unknown_category` で計上待ちに止まる）。
 * - sale: 売上の元本は Task 2。`reporting_category` が charge でない charge・payment は知らない種類として止める。
 * - refund_principal: 元本は計画3（係は飛ばす）。手数料があれば手数料の係が1件1本にする。
 * - fee_only: 単独の手数料。額は `-net`（`fee = 0` でも）。
 * - tax_adjustment: 消費税の調整（JCT tax adjustment）。名前が合うかは未確認 #1 で、違えば unknown_category で止まるだけ。
 * - payout: 入金の本体は `stripe_payouts` から作る。取引の行は飛ばす。
 * - payout_failure: 入金の失敗・取り消しの戻りの取引。
 * - dispute: 支払いの取り消し。元本は Task 6、手数料は手数料の係。
 * - manual_topup: 残高の補充。手入力で入れる。止めずに飛ばし、残高の照合で名指す。
 */
export const STRIPE_CATEGORY_RULES: readonly StripeCategoryRule[] = [
	{ kind: 'sale', types: ['charge', 'payment'], reportingCategories: ['charge'] },
	{ kind: 'refund_principal', types: ['refund', 'payment_refund', 'refund_failure'] },
	{ kind: 'fee_only', types: ['stripe_fee', 'stripe_fx_fee'] },
	{ kind: 'tax_adjustment', types: ['tax_fee'] },
	{ kind: 'payout', types: ['payout'] },
	{ kind: 'payout_failure', types: ['payout_failure', 'payout_cancel'] },
	{ kind: 'dispute', types: ['adjustment'], reportingCategories: ['dispute', 'dispute_reversal'] },
	{ kind: 'manual_topup', types: ['topup', 'topup_reversal'] },
];

/** 取引の種類を係の扱いへ直す。知らない種類は null。 */
export function kindOfStripeCategory(type: string, reportingCategory: string): StripeCategoryKind | null {
	for (const rule of STRIPE_CATEGORY_RULES) {
		if (!rule.types.includes(type)) continue;
		if (rule.reportingCategories && !rule.reportingCategories.includes(reportingCategory)) continue;
		return rule.kind;
	}
	return null;
}

const quote = (value: string) => `'${value}'`;

/** SQL の `private.accounting_stripe_category_kind` の全文（移行の本文へ貼る）。 */
export function buildStripeCategoryKindSql(): string {
	const branches = STRIPE_CATEGORY_RULES.map((rule) => {
		const types = `_type IN (${rule.types.map(quote).join(', ')})`;
		const categories = rule.reportingCategories
			? ` AND _reporting_category IN (${rule.reportingCategories.map(quote).join(', ')})`
			: '';
		return `    WHEN ${types}${categories} THEN ${quote(rule.kind)}`;
	}).join('\n');
	return `CREATE FUNCTION private.accounting_stripe_category_kind(_type text, _reporting_category text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
${branches}
    ELSE NULL
  END
$$;
`;
}
