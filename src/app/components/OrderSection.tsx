'use client';

import { Button } from '@/app/components/ui/Button';
import { DataTable } from '@/app/components/ui/DataTable';
import { StatusBadge } from '@/app/components/ui/StatusBadge';

export type OrderStatus = '未決済' | '決済完了' | '出荷完了' | '配達完了' | 'キャンセル';

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
};

const actionLabelMap: Partial<Record<OrderStatus, string>> = {
	未決済: '決済完了',
	決済完了: '出荷完了',
	出荷完了: '配達完了',
};

interface OrderSectionProps {
	orders: OrderItem[];
	onTransitStatus: (id: string) => void;
}

export default function OrderSection({ orders, onTransitStatus }: OrderSectionProps) {

	const statusClassMap: Record<OrderStatus, string> = {
		未決済: 'bg-red-100 text-red-800',
		決済完了: 'bg-yellow-100 text-yellow-800',
		出荷完了: 'bg-blue-100 text-blue-800',
		配達完了: 'bg-green-100 text-green-800',
		キャンセル: 'bg-gray-100 text-gray-500',
	};

	return (
		<section>
			<DataTable
				rows={orders}
				rowKey={(order) => order.id}
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
						header: '出荷状況',
						render: (order) => (
							<StatusBadge
								tone={
									order.status === '配達完了'
										? 'positive'
										: order.status === 'キャンセル'
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
						render: (order) =>
							actionLabelMap[order.status] ? (
								<Button variant="secondary" size="sm" className="font-acumin" onClick={() => onTransitStatus(order.id)}>
									{actionLabelMap[order.status]}
								</Button>
							) : null,
					},
				]}
			 size="md"/>
		</section>
	);
}
