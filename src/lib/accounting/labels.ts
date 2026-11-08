// 仕訳の説明・メモ・相手の日本語（計画2）。SQL の日本語は `U&'\XXXX'` 形で、scripts/accounting/emit-labels.ts が
// ここから出す文字列を貼る。移行の本文に生の日本語を書かない（試験が TS との一致を確かめる）。

export const ACCOUNTING_LABELS = {
	/** 支払いの仕訳の説明（Stripe 未収金／前受金）。 */
	paymentReceived: '支払いの受け取り（前受金）',
	/** 出荷の仕訳の説明（前受金／売上高）。 */
	shipmentRevenue: '出荷による売上',
	/** 出荷の取り消しの仕訳の理由。 */
	shipmentCancelled: '出荷の取り消し',
	/** 出荷の仕訳の行のメモ「品名 × 数量」の間の字（前後に空白）。 */
	quantityTimes: ' × ',
	/** 決済会社の相手の名前。 */
	stripeJapan: 'ストライプジャパン株式会社',
	feePayment: '決済の手数料',
	feeDispute: '取り消しの手数料',
	feeFx: '為替の手数料',
	taxAdjustment: '消費税の調整',
	payoutStarted: '銀行への入金の開始',
	bankArrived: '銀行への着金',
	payoutFailed: '入金の失敗',
	balanceTopup: '残高の補充',
	/** カード会社からの支払いの取り消しで代金が引かれた時。 */
	disputeWithdrawn: 'カード会社からの支払いの取り消し',
	disputeConfirmed: 'カード会社からの支払いの取り消しの確定',
	disputeReversal: 'カード会社からの支払いの取り消しの取り下げ',
	disputeAssigned: 'カード会社からの支払いの取り消しの科目の振り替え',
} as const;

export type AccountingLabelKey = keyof typeof ACCOUNTING_LABELS;

/** SQL の `U&'…'` 形。ASCII はそのまま、ほかの文字は `\XXXX`。引用符は二重、`\` も二重にする。 */
export function encodeSqlUnicodeLiteral(value: string): string {
	const body = Array.from(value)
		.map((char) => {
			const code = char.codePointAt(0) as number;
			if (code > 0xffff) throw new Error('labels must stay inside the BMP');
			if (code >= 0x80) return `\\${code.toString(16).toUpperCase().padStart(4, '0')}`;
			if (char === "'") return "''";
			if (char === '\\') return '\\\\';
			return char;
		})
		.join('');
	return `U&'${body}'`;
}
