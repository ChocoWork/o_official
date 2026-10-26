import type { OrderReturnSummary, ReturnNextAction } from '@/lib/orders/returns/return-types';

export const RETURN_BUTTON_LABELS: Record<ReturnNextAction, string> = {
	review_request: '申し込みを確かめる',
	refund: '額を決めて返金する',
	receive: '受け取る',
	none: '返品',
};

/**
 * 「返品」のボタンの名前。額を決めて返金するのは店長だけなので、サポートの人には出さず、設計書 8-1 の順の次にする:
 * 受付中の返品にまだ受け取っていない品があれば「受け取る」、無ければ「返品」。窓口の次にすることは役割を知らずに決まるので、
 * 受け取る品があるかは要約の印で見る（受け取り待ち・一部受け取りは、受付中の返品に未処理の品がある時だけ付く）
 */
export function returnButtonLabel(summary: OrderReturnSummary, canRefundReturn: boolean): string {
	if (summary.nextAction !== 'refund' || canRefundReturn) {
		return RETURN_BUTTON_LABELS[summary.nextAction];
	}
	const hasItemsToReceive =
		summary.displayStatus === 'in_progress' &&
		summary.marks.some((mark) => mark === 'awaiting_items' || mark === 'partially_received');
	return hasItemsToReceive ? RETURN_BUTTON_LABELS.receive : RETURN_BUTTON_LABELS.none;
}

/** 返品がある注文か、返品できる品がある注文だけに「返品」のボタンを出す（どちらも無ければ、開く物が無い） */
export function hasReturnsToShow(summary: OrderReturnSummary): boolean {
	return Boolean(summary.displayStatus) || summary.hasReturnable;
}

