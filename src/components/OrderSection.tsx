'use client';

import { Button } from '@/components/ui/Button/Button';
import { DataTable } from '@/components/ui/DataTable/DataTable';
import { StatusBadge, type StatusBadgeTone } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus as DbOrderStatus } from '@/lib/orders/order-payment-types';
import { PARTIALLY_SHIPPED_LABEL, type OrderProgressKey } from '@/lib/orders/order-progress';
import { PAYMENT_STATUS_LABELS, REFUND_FAILED_BADGE, REFUND_PENDING_BADGE, type PaymentStatusKey } from '@/lib/orders/payment-status';
import { cn } from '@/lib/utils';

export type OrderStatus =
	| '支払い手続き中'
	| '未決済'
	| '受注生産中'
	| '発送準備中'
	| '配送中'
	| '配達済み'
	| '決済失敗'
	| '放棄'
	| 'キャンセル'
	| 'キャンセルの手続き中';

export type OrderLineItem = {
	/** 注文の商品の番号。React の key に使う（同じ商品の色違いが重なるため、名前では区別できない） */
	id: string;
	name: string;
	color: string | null;
	size: string | null;
	quantity: number;
	fulfillmentType: 'stock' | 'backorder';
	/** 発送した数 */
	shipped: number;
	/** 受注生産中の数（まだ仕上がっていない数） */
	inProduction: number;
	/** 発送準備中の数（仕上がっていて、まだ送っていない数） */
	readyUnshipped: number;
};

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	items: OrderLineItem[];
	totalAmount: string;
	/** 注文の言葉（受注生産中・発送準備中・配送中など）。記録から出した物 */
	status: OrderStatus;
	/** DB の注文の状態。件数・絞り込み・CSV の判断はこれを使う（言葉は表示のため） */
	orderStatus?: DbOrderStatus;
	progressKey?: OrderProgressKey;
	/** 発送した数があり、未発送の数も残っている */
	partiallyShipped?: boolean;
	canRefund?: boolean;
	canShip?: boolean;
	/** 受注生産中の数がある決済完了の注文 */
	canRecordCompletion?: boolean;
	missingShippingFields?: string[];
	/** 在庫を確保できなかった入金済みの注文（要確認）。確認済みにするまで印を出す */
	needsReview?: boolean;
	/** 発送できない理由（支払額の違いの要対応）。発送ボタンの代わりに出す */
	shipBlockedReason?: string | null;
	/** キャンセルできる注文（未入金の注文と、支払い済みで1つも発送していない注文。種類は cancelKind） */
	canCancel?: boolean;
	/** 払込票が有効な間は取り消せない。その払込期限（ISO） */
	cancelBlockedUntil?: string | null;
	/** 支払いの言葉の記号（未入金・支払い済み・一部返金など）。言葉と色は「支払い」の列が決める */
	paymentStatusKey?: PaymentStatusKey;
	/** 返事待ち・保留の返金がある（「返金の手続き中」の印） */
	refundPending?: boolean;
	/** 開いている「返金の失敗」の要対応がある（「返金の失敗」の印） */
	refundFailed?: boolean;
	/** 成功した返金の合計（￥12,800）。返金が無ければ - */
	refundedAmountLabel?: string;
	/** キャンセルの種類。unpaid は未入金の取消（取消の画面）、paid は支払い済みのキャンセル（返金を伴う画面）。出さない注文は null */
	cancelKind?: 'unpaid' | 'paid' | null;
};

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	noticeMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	onShipOrder?: (id: string) => void;
	/** 受注生産の品の仕上がりを記録する画面を開く */
	onRecordCompletion?: (id: string) => void;
	/** 注文の履歴（状態の変化とメール）を開く */
	onShowHistory?: (id: string) => void;
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

function formatDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** 「ブラウス（白 / M）×2（受注生産中 1・発送済み 1）」。括弧の中は0でない数だけ */
function formatOrderLineItem(item: OrderLineItem): string {
	const variant = [item.color, item.size].filter((part): part is string => Boolean(part)).join(' / ');
	const counts = [
		item.inProduction > 0 ? `受注生産中 ${item.inProduction}` : null,
		item.readyUnshipped > 0 ? `発送準備中 ${item.readyUnshipped}` : null,
		item.shipped > 0 ? `発送済み ${item.shipped}` : null,
	].filter((part): part is string => part !== null);
	const name = variant ? `${item.name}（${variant}）` : item.name;
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
	onShipOrder,
	onRecordCompletion,
	onShowHistory,
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

			<DataTable
				rows={orders}
				rowKey={(order) => order.id}
				emptyLabel="条件に一致する注文はありません"
				columns={[
					{
						key: 'id',
						header: '注文ID',
						render: (order) => <p className="font-medium font-acumin">{order.id}</p>,
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
							</div>
						),
					},
					{
						key: 'action',
						header: '操作',
						render: (order) => {
							const isProcessing = processingOrderIds.includes(order.id);
							const hasMissingShipping = (order.missingShippingFields?.length ?? 0) > 0;
							const awaitingShipment = isAwaitingShipment(order);

							return (
							<div className="flex flex-wrap items-center gap-2">
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
								{awaitingShipment && order.shipBlockedReason ? (
									<span className="lk-text-xs text-red-700" role="status">{order.shipBlockedReason}</span>
								) : null}
								{/* canShip が false になる理由は、配送先が足りない・支払額の確かめ・送る品が残っていない、の3つ。配送先が実際に足りない時だけ出す */}
								{awaitingShipment && hasMissingShipping ? (
									<span className="lk-text-xs text-red-700" role="status">配送先要確認</span>
								) : null}
								{order.canRecordCompletion && onRecordCompletion ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onRecordCompletion(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '仕上がりを記録する'}
									</Button>
								) : null}
								{order.canShip && onShipOrder ? (
									<Button
										variant="primary"
										size="sm"
										className="font-acumin"
										onClick={() => onShipOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '発送済みにする'}
									</Button>
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
