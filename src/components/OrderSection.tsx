'use client';

import { Button } from '@/components/ui/Button/Button';
import { DataTable } from '@/components/ui/DataTable/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';

export type OrderStatus = '支払い手続き中' | '未決済' | '決済完了' | '決済失敗' | '放棄' | 'キャンセル' | '発送済み';

export type OrderLineItem = {
	name: string;
	quantity: number;
};

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	items: OrderLineItem[];
	totalAmount: string;
	status: OrderStatus;
	canRefund?: boolean;
	canShip?: boolean;
	missingShippingFields?: string[];
	/** 在庫を確保できなかった入金済みの注文（要確認）。確認済みにするまで印を出す */
	needsReview?: boolean;
	/** 発送できない理由（支払額の違いの要対応）。発送ボタンの代わりに出す */
	shipBlockedReason?: string | null;
	/** 取り消せる未入金の注文（支払い手続き中・入金待ち・失敗） */
	canCancel?: boolean;
	/** 払込票が有効な間は取り消せない。その払込期限（ISO） */
	cancelBlockedUntil?: string | null;
};

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	noticeMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	onShipOrder?: (id: string) => void;
	processingOrderIds?: string[];
}

function formatDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function OrderSection({
	orders,
	isLoading = false,
	errorMessage = null,
	noticeMessage = null,
	onCancelOrder,
	onRefundOrder,
	onShipOrder,
	processingOrderIds = [],
}: OrderSectionProps) {

	const statusClassMap: Record<OrderStatus, string> = {
		支払い手続き中: 'bg-gray-100 text-[#474747]',
		未決済: 'bg-red-100 text-red-800',
		決済完了: 'bg-yellow-100 text-yellow-800',
		決済失敗: 'bg-orange-100 text-orange-800',
		放棄: 'bg-gray-100 text-gray-500',
		キャンセル: 'bg-gray-100 text-gray-500',
		発送済み: 'bg-green-100 text-green-800',
	};

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
									<p key={`${order.id}-${item.name}`} className="lk-text-sm text-black font-acumin">
										{item.name} × {item.quantity}
									</p>
								))}
							</div>
						),
					},
					{ key: 'count', header: '商品数', render: (order) => <p className="font-acumin">{order.itemCount}</p> },
					{ key: 'total', header: '合計金額', render: (order) => <p className="font-acumin">{order.totalAmount}</p> },
					{
						key: 'status',
						header: '決済状況',
						render: (order) => (
							<div className="flex flex-wrap items-center gap-1">
								<StatusBadge
									tone={
										order.status === '決済完了'
											? 'positive'
											: order.status === '決済失敗' || order.status === 'キャンセル' || order.status === '放棄'
												? 'danger'
												: 'warning'
									}
									className={statusClassMap[order.status]}
									size="md"
								>
									{order.status}
								</StatusBadge>
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

							return (
							<div className="flex flex-wrap items-center gap-2">
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
								{order.status === '決済完了' && order.shipBlockedReason ? (
									<span className="lk-text-xs text-red-700" role="status">{order.shipBlockedReason}</span>
								) : null}
								{order.status === '決済完了' && order.canShip === false && (!order.shipBlockedReason || hasMissingShipping) ? (
									<span className="lk-text-xs text-red-700" role="status">配送先要確認</span>
								) : null}
								{order.status === '決済完了' && order.canShip && onShipOrder ? (
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
