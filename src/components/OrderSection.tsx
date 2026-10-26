'use client';

import { Button } from '@/components/ui/Button/Button';
import { DataTable } from '@/components/ui/DataTable/DataTable';
import { StatusBadge, type StatusBadgeTone } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { MANUAL_COMPLETION_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import { toOrderNumber } from '@/lib/orders/order-number';
import { PARTIALLY_SHIPPED_LABEL } from '@/lib/orders/order-progress';
import { PAYMENT_STATUS_LABELS, REFUND_FAILED_BADGE, REFUND_PENDING_BADGE, type PaymentStatusKey } from '@/lib/orders/payment-status';
import { RETURN_DISPLAY_STATUS_LABELS, RETURN_MARK_LABELS } from '@/lib/orders/returns/return-messages';
import type { ReturnDisplayStatus } from '@/lib/orders/returns/return-types';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DELIVERY_ATTENTION_LABELS } from '@/lib/orders/tracking/delivery-messages';
import { cn } from '@/lib/utils';

/** 返品の交換で足された品の行の印（購入商品の欄に付ける。C-5） */
const EXCHANGE_ITEM_LABEL = '交換の品';

export type { OrderStatus, OrderLineItem, OrderItem } from '@/lib/orders/admin-orders/admin-order-types';
import type { OrderStatus, OrderLineItem, OrderItem } from '@/lib/orders/admin-orders/admin-order-types';
import { returnButtonLabel, hasReturnsToShow } from '@/lib/orders/admin-orders/admin-order-actions';

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	noticeMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	/** 注文の履歴（状態の変化とメール）を開く */
	onShowHistory?: (id: string) => void;
	/** 返品の画面（返品の一覧・受け取り・返金・作る）を開く */
	onShowReturns?: (id: string) => void;
	/** キャンセルの申し込みの画面を開く（開いている申し込みのある注文のボタン。店長もサポートの人も押せる） */
	onShowCancelRequest?: (id: string) => void;
	/** 「額を決めて返金する」を押せる人（店長）か。サポートの人には、その名前を出さず、受け取る品が残っていれば「受け取る」、無ければ「返品」にする */
	canRefundReturn?: boolean;
	processingOrderIds?: string[];
}

const STATUS_TONES: Record<OrderStatus, StatusBadgeTone> = {
	支払い手続き中: 'warning',
	未決済: 'warning',
	受注生産中: 'positive',
	発送準備中: 'positive',
	配送中: 'positive',
	配達済み: 'positive',
	決済失敗: 'danger',
	放棄: 'danger',
	キャンセル: 'danger',
	キャンセルの手続き中: 'warning',
};

const STATUS_CLASSES: Record<OrderStatus, string> = {
	支払い手続き中: 'bg-gray-100 text-[#474747]',
	未決済: 'bg-red-100 text-red-800',
	受注生産中: 'bg-blue-100 text-blue-800',
	発送準備中: 'bg-yellow-100 text-yellow-800',
	配送中: 'bg-green-100 text-green-800',
	配達済み: 'bg-green-100 text-green-800',
	決済失敗: 'bg-orange-100 text-orange-800',
	放棄: 'bg-gray-100 text-[#474747]',
	キャンセル: 'bg-gray-100 text-gray-500',
	キャンセルの手続き中: 'bg-gray-100 text-[#474747]',
};

// 「進み具合」の列の配送の印の言葉（C-5）。追跡できない = 伝票番号で荷物が見つからない・追跡の登録ができない・配達済みにならない
const DELIVERY_ATTENTION_MARKS: Record<NonNullable<OrderItem['deliveryAttention']>, string> = {
	failure: DELIVERY_ATTENTION_LABELS.delivery_failure,
	attempted_delivery: DELIVERY_ATTENTION_LABELS.attempted_delivery,
	untrackable: '追跡できない',
};

// 「支払い」の列の言葉の色。進み具合の言葉と並べて読むので、色の使い方をそろえる
// （未入金は未決済と同じ赤、失敗は決済失敗と同じ橙、済んだ物は緑。返金は灰で、続きがある一部返金だけ黄）
const PAYMENT_TONES: Record<PaymentStatusKey, StatusBadgeTone> = {
	unpaid: 'warning',
	failed: 'danger',
	none: 'neutral',
	paid: 'positive',
	partially_refunded: 'warning',
	refunded: 'neutral',
};

const PAYMENT_CLASSES: Record<PaymentStatusKey, string> = {
	unpaid: 'bg-red-100 text-red-800',
	failed: 'bg-orange-100 text-orange-800',
	none: 'bg-gray-100 text-[#474747]',
	paid: 'bg-green-100 text-green-800',
	partially_refunded: 'bg-yellow-100 text-yellow-800',
	refunded: 'bg-gray-100 text-[#474747]',
};

// 「返品」の列の言葉の色。申し込みと返金待ちは店が動く番なので目立たせ（赤・黄）、返品中は作業中（青。受注生産中と同じ）、済んだ物は灰
const RETURN_STATUS_TONES: Record<ReturnDisplayStatus, StatusBadgeTone> = {
	requested: 'warning',
	in_progress: 'neutral',
	refund_waiting: 'warning',
	returned: 'neutral',
};

const RETURN_STATUS_CLASSES: Record<ReturnDisplayStatus, string> = {
	requested: 'bg-red-100 text-red-800',
	in_progress: 'bg-blue-100 text-blue-800',
	refund_waiting: 'bg-yellow-100 text-yellow-800',
	returned: 'bg-gray-100 text-[#474747]',
};

function formatDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * 「ブラウス（白 / M）×2（受注生産中 1・発送済み 1）」。括弧の中は0でない数だけ。
 * 交換の品の行は C-5 のとおり「ブラウス（白 / M） × 1（交換の品）」。数の言葉が続く時は「（交換の品・発送準備中 1）」と、同じ括弧の中に「・」でつなぐ
 */
function formatOrderLineItem(item: OrderLineItem): string {
	const variant = [item.color, item.size].filter((part): part is string => Boolean(part)).join(' / ');
	const counts = [
		item.inProduction > 0 ? `受注生産中 ${item.inProduction}` : null,
		item.readyUnshipped > 0 ? `発送準備中 ${item.readyUnshipped}` : null,
		item.shipped > 0 ? `発送済み ${item.shipped}` : null,
	].filter((part): part is string => part !== null);
	const name = variant ? `${item.name}（${variant}）` : item.name;
	if (item.lineKind === 'exchange') {
		return `${name} × ${item.quantity}（${[EXCHANGE_ITEM_LABEL, ...counts].join('・')}）`;
	}
	return counts.length > 0 ? `${name}×${item.quantity}（${counts.join('・')}）` : `${name}×${item.quantity}`;
}

/** 発送待ち（DB の状態が paid）か。受注生産中・発送準備中の言葉がこれにあたる */
function isAwaitingShipment(order: OrderItem): boolean {
	return order.orderStatus ? order.orderStatus === 'paid' : order.status === '受注生産中' || order.status === '発送準備中';
}

export default function OrderSection({
	orders,
	isLoading = false,
	errorMessage = null,
	noticeMessage = null,
	onCancelOrder,
	onRefundOrder,
	onShowHistory,
	onShowReturns,
	onShowCancelRequest,
	canRefundReturn = false,
	processingOrderIds = [],
}: OrderSectionProps) {

	if (isLoading) {
		return (
			<section>
				<p className="lk-text-sm text-[#474747] font-acumin">注文一覧を読み込み中です...</p>
			</section>
		);
	}

	return (
		<section>
			{errorMessage ? (
				<p role="alert" className="mb-4 lk-text-sm text-red-700 font-acumin">{errorMessage}</p>
			) : null}
			{noticeMessage ? (
				<p role="status" aria-live="polite" className="mb-4 lk-text-sm text-[#474747] font-acumin">
					{noticeMessage}
				</p>
			) : null}
			{/*
				G-1 Task 15 / G-3: 旧の発送・手動の仕上がりの入口は撤去した。発送は荷作り表の発送票で行うので、注文の行ごとではなく表の上に1回ずつ伝える。
				画面の幅が狭くても折り返す（折り返しを止める指定や固定の幅を付けない）
			*/}
			<div className="mb-4 space-y-2">
				<p className="lk-text-sm text-[#474747] font-acumin">{SHIPMENT_SLIP_TEXT.orderSectionGuide}</p>
				<div>
					<Button href="/admin/packing" variant="secondary" size="sm" className="font-acumin">{SHIPMENT_SLIP_TEXT.openPacking}</Button>
				</div>
				<p className="lk-text-sm text-[#474747] font-acumin">{MANUAL_COMPLETION_DISABLED_TEXT}</p>
			</div>

			<DataTable
				rows={orders}
				rowKey={(order) => order.id}
				emptyLabel="条件に一致する注文はありません"
				columns={[
					{
						key: 'id',
						header: '注文ID',
						// 番号（UUID）は36字で、折り返さないと列が広がり、表が枠に入らなくなる。字は変えず、ハイフンの所で折り返させる。
						// break-all は付けない: 折り返せる所が字ごとに増え、列が見出しの幅まで潰れて番号が7行に折れる（ハイフンの所だけなら4行）
						render: (order) => <p className="max-w-[9rem] font-medium font-acumin">{order.id}</p>,
					},
					{
						key: 'customer',
						header: '顧客名',
						render: (order) => (
							<div>
								<p className="lk-text-sm text-black font-acumin">{order.customerName}</p>
								<p className="lk-text-3xs text-[#474747] font-acumin">{order.customerEmail}</p>
							</div>
						),
					},
					{ key: 'date', header: '注文日', render: (order) => <p className="text-[#474747] font-acumin">{order.orderDate}</p> },
					{
						key: 'items',
						header: '購入商品',
						// 幅の下限。表が枠より広い時に、この列が潰れて商品名が1行ずつ折れ続けるのを防ぐ
						className: 'min-w-[14rem]',
						render: (order) => (
							<div className="space-y-1">
								{order.items.map((item) => (
									<p key={item.id} className="lk-text-sm text-black font-acumin">
										{formatOrderLineItem(item)}
									</p>
								))}
							</div>
						),
					},
					{ key: 'count', header: '商品数', render: (order) => <p className="font-acumin">{order.itemCount}</p> },
					{ key: 'total', header: '合計金額', render: (order) => <p className="font-acumin">{order.totalAmount}</p> },
					{
						key: 'payment',
						header: '支払い',
						render: (order) => (
							<div className="flex flex-wrap items-center gap-1">
								{order.paymentStatusKey ? (
									<StatusBadge
										tone={PAYMENT_TONES[order.paymentStatusKey]}
										className={cn(PAYMENT_CLASSES[order.paymentStatusKey], 'whitespace-nowrap')}
										size="md"
									>
										{PAYMENT_STATUS_LABELS[order.paymentStatusKey]}
									</StatusBadge>
								) : null}
								{order.refundPending ? (
									<TagLabel variant="outline" size="2xs">{REFUND_PENDING_BADGE}</TagLabel>
								) : null}
								{order.refundFailed ? (
									<TagLabel variant="outline" size="2xs">{REFUND_FAILED_BADGE}</TagLabel>
								) : null}
							</div>
						),
					},
					{
						key: 'status',
						header: '進み具合',
						render: (order) => (
							<div className="flex flex-wrap items-center gap-1">
								{/* 「受注生産中」「発送準備中」などは、狭い画面幅でも途中で折り返さない */}
								<StatusBadge tone={STATUS_TONES[order.status]} className={cn(STATUS_CLASSES[order.status], 'whitespace-nowrap')} size="md">
									{order.status}
								</StatusBadge>
								{order.partiallyShipped ? (
									<TagLabel variant="outline" size="2xs">{PARTIALLY_SHIPPED_LABEL}</TagLabel>
								) : null}
								{order.needsReview ? (
									<TagLabel variant="outline" size="2xs">要確認</TagLabel>
								) : null}
								{order.deliveryAttention ? (
									<TagLabel variant="outline" size="2xs">{DELIVERY_ATTENTION_MARKS[order.deliveryAttention]}</TagLabel>
								) : null}
							</div>
						),
					},
					{
						key: 'return',
						header: '返品',
						render: (order) => {
							const summary = order.returnSummary;
							if (!summary?.displayStatus) {
								return <p className="font-acumin text-[#474747]">—</p>;
							}
							return (
								<div className="flex flex-wrap items-center gap-1">
									<StatusBadge
										tone={RETURN_STATUS_TONES[summary.displayStatus]}
										className={cn(RETURN_STATUS_CLASSES[summary.displayStatus], 'whitespace-nowrap')}
										size="md"
									>
										{RETURN_DISPLAY_STATUS_LABELS[summary.displayStatus]}
									</StatusBadge>
									{summary.marks.map((mark) => (
										<TagLabel key={mark} variant="outline" size="2xs">{RETURN_MARK_LABELS[mark]}</TagLabel>
									))}
								</div>
							);
						},
					},
					{
						key: 'action',
						header: '操作',
						// 右に貼り付け、表が横に動いても操作のボタンを画面の中に置く（下の字や色が透けないよう、見出しと中にそれぞれ背景色を付ける）。
						// 表は border-collapse: collapse で、border は貼り付かず置いていかれるため、左の線は内側の影で引く
						className: 'sticky right-0 shadow-[inset_1px_0_0_var(--table-border-color)]',
						headerClassName: 'bg-[var(--table-header-bg)]',
						cellClassName: 'bg-[var(--table-bg)]',
						render: (order) => {
							const isProcessing = processingOrderIds.includes(order.id);
							const hasMissingShipping = (order.missingShippingFields?.length ?? 0) > 0;
							const awaitingShipment = isAwaitingShipment(order);

							return (
							// 貼り付けた列を狭く保つため、ボタンは縦に並べて同じ幅にそろえる
							<div className="flex flex-col items-stretch gap-2">
								{onShowHistory ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										aria-label={`${toOrderNumber(order.id)} の履歴`}
										onClick={() => onShowHistory(order.id)}
									>
										履歴
									</Button>
								) : null}
								{order.canRefund && onRefundOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onRefundOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '返金'}
									</Button>
								) : null}
								{order.returnSummary && onShowReturns && hasReturnsToShow(order.returnSummary) ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onShowReturns(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : returnButtonLabel(order.returnSummary, canRefundReturn)}
									</Button>
								) : null}
								{order.cancelRequestOpen && onShowCancelRequest ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onShowCancelRequest(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : 'キャンセルの申し込み'}
									</Button>
								) : null}
								{awaitingShipment && order.shipBlockedReason ? (
									<span className="lk-text-xs text-red-700" role="status">{order.shipBlockedReason}</span>
								) : null}
								{/* canShip が false になる理由は、配送先が足りない・支払額の確かめ・送る品が残っていない、の3つ。配送先が実際に足りない時だけ出す */}
								{awaitingShipment && hasMissingShipping ? (
									<span className="lk-text-xs text-red-700" role="status">配送先要確認</span>
								) : null}
								{order.canCancel && onCancelOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onCancelOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : 'キャンセル'}
									</Button>
								) : null}
								{order.cancelBlockedUntil ? (
									<span className="lk-text-xs text-[#474747]" role="status">
										払込票の期限切れが確定するまで取り消せません（払込期限 {formatDeadline(order.cancelBlockedUntil)}）
									</span>
								) : null}
								{order.status === '未決済' && order.canCancel === false && !order.cancelBlockedUntil ? (
									<span className="lk-text-xs text-[#474747]" role="status">
										支払いの状態を確かめられないため、今は取り消せません
									</span>
								) : null}
							</div>
							);
						},
					},
				]}
			 size="md"/>
		</section>
	);
}
