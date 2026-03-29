'use client';

import { Button } from '@/components/ui/Button';
import { DataTable } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';

export type OrderStatus = '未決済' | '決済完了' | '決済失敗' | 'キャンセル';

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
};

const actionLabelMap: Partial<Record<OrderStatus, string>> = {
	未決済: 'キャンセル',
	決済完了: 'キャンセル',
};

interface OrderSectionProps {
	orders: OrderItem[];
	isLoading?: boolean;
	errorMessage?: string | null;
	onCancelOrder?: (id: string) => void;
	onRefundOrder?: (id: string) => void;
	processingOrderIds?: string[];
}

export default function OrderSection({
	orders,
	isLoading = false,
	errorMessage = null,
	onCancelOrder,
	onRefundOrder,
	processingOrderIds = [],
}: OrderSectionProps) {

	const statusClassMap: Record<OrderStatus, string> = {
		未決済: 'bg-red-100 text-red-800',
		決済完了: 'bg-yellow-100 text-yellow-800',
		決済失敗: 'bg-orange-100 text-orange-800',
		キャンセル: 'bg-gray-100 text-gray-500',
	};

	if (isLoading) {
		return (
			<section>
				<p className="text-sm text-[#474747] font-acumin">注文一覧を読み込み中です...</p>
			</section>
		);
	}

	return (
		<section>
			{errorMessage && <p className="mb-4 text-sm text-red-700 font-acumin">{errorMessage}</p>}

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
								<p className="text-sm text-black font-acumin">{order.customerName}</p>
								<p className="text-xs text-[#474747] font-acumin">{order.customerEmail}</p>
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
									<p key={`${order.id}-${item.name}`} className="text-sm text-black font-acumin">
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
							<StatusBadge
								tone={
									order.status === '決済完了'
										? 'positive'
										: order.status === '決済失敗' || order.status === 'キャンセル'
											? 'danger'
											: 'warning'
								}
								className={statusClassMap[order.status]}
							 size="md">
								{order.status}
							</StatusBadge>
						),
					},
					{
						key: 'action',
						header: '操作',
						render: (order) => {
							const isProcessing = processingOrderIds.includes(order.id);

							return (
							<div className="flex items-center gap-2">
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
								{actionLabelMap[order.status] && onCancelOrder ? (
									<Button
										variant="secondary"
										size="sm"
										className="font-acumin"
										onClick={() => onCancelOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : actionLabelMap[order.status]}
									</Button>
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
