'use client';

import { useMemo, useState } from 'react';

type OrderStatus = '未出荷' | '準備中' | '出荷完了' | '配達完了' | 'キャンセル';

type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	totalAmount: string;
	status: OrderStatus;
};

const statusTransitionMap: Partial<Record<OrderStatus, OrderStatus>> = {
	未出荷: '準備中',
	準備中: '出荷完了',
	出荷完了: '配達完了',
};

const actionLabelMap: Partial<Record<OrderStatus, string>> = {
	未出荷: '準備開始',
	準備中: '出荷完了',
	出荷完了: '配達完了',
};

export default function OrderSection() {
	const [orders, setOrders] = useState<OrderItem[]>([
		{
			id: 'ORD-2025-0156',
			customerName: '中村 優子',
			customerEmail: 'nakamura@example.com',
			orderDate: '2025-01-15',
			itemCount: '3点',
			totalAmount: '¥78,000',
			status: '未出荷',
		},
		{
			id: 'ORD-2025-0155',
			customerName: '小林 大輔',
			customerEmail: 'kobayashi@example.com',
			orderDate: '2025-01-15',
			itemCount: '2点',
			totalAmount: '¥45,000',
			status: '準備中',
		},
		{
			id: 'ORD-2025-0154',
			customerName: '加藤 真理',
			customerEmail: 'kato@example.com',
			orderDate: '2025-01-14',
			itemCount: '4点',
			totalAmount: '¥128,000',
			status: '出荷完了',
		},
		{
			id: 'ORD-2025-0153',
			customerName: '吉田 翔太',
			customerEmail: 'yoshida@example.com',
			orderDate: '2025-01-14',
			itemCount: '1点',
			totalAmount: '¥35,000',
			status: '配達完了',
		},
		{
			id: 'ORD-2025-0152',
			customerName: '渡辺 美穂',
			customerEmail: 'watanabe@example.com',
			orderDate: '2025-01-13',
			itemCount: '3点',
			totalAmount: '¥92,000',
			status: '配達完了',
		},
		{
			id: 'ORD-2025-0151',
			customerName: '松本 健一',
			customerEmail: 'matsumoto@example.com',
			orderDate: '2025-01-12',
			itemCount: '2点',
			totalAmount: '¥56,000',
			status: 'キャンセル',
		},
	]);

	const statusClassMap: Record<OrderStatus, string> = {
		未出荷: 'bg-red-100 text-red-800',
		準備中: 'bg-yellow-100 text-yellow-800',
		出荷完了: 'bg-blue-100 text-blue-800',
		配達完了: 'bg-green-100 text-green-800',
		キャンセル: 'bg-gray-100 text-gray-500',
	};

	const pendingShipmentCount = useMemo(
		() => orders.filter((order) => order.status === '未出荷').length,
		[orders],
	);

	const preparingShipmentCount = useMemo(
		() => orders.filter((order) => order.status === '準備中').length,
		[orders],
	);

	const handleTransitStatus = (id: string) => {
		setOrders((prevOrders) =>
			prevOrders.map((order) => {
				if (order.id !== id) return order;

				const nextStatus = statusTransitionMap[order.status];
				if (!nextStatus) return order;

				return {
					...order,
					status: nextStatus,
				};
			}),
		);
	};

	return (
		<section>
			<div className="flex justify-between items-center mb-8">
				<h3 className="text-2xl text-black font-didot">ORDER管理</h3>
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-2 text-sm font-acumin">
						<span className="w-3 h-3 bg-red-100 rounded-full" />
						<span className="text-[#474747]">未出荷: {pendingShipmentCount}</span>
					</div>
					<div className="flex items-center gap-2 text-sm font-acumin">
						<span className="w-3 h-3 bg-yellow-100 rounded-full" />
						<span className="text-[#474747]">準備中: {preparingShipmentCount}</span>
					</div>
				</div>
			</div>

			<div className="border border-[#d5d0c9] overflow-hidden overflow-x-auto">
				<table className="w-full min-w-[900px]">
					<thead className="bg-[#f5f5f5]">
						<tr>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">注文ID</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">顧客名</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">注文日</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">商品数</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">合計金額</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">出荷状況</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">操作</th>
						</tr>
					</thead>
					<tbody>
						{orders.map((order) => (
							<tr key={order.id} className="border-t border-[#d5d0c9]">
								<td className="px-6 py-4 text-sm text-black font-medium font-acumin">{order.id}</td>
								<td className="px-6 py-4">
									<p className="text-sm text-black font-acumin">{order.customerName}</p>
									<p className="text-xs text-[#474747] font-acumin">{order.customerEmail}</p>
								</td>
								<td className="px-6 py-4 text-sm text-[#474747] font-acumin">{order.orderDate}</td>
								<td className="px-6 py-4 text-sm text-black font-acumin">{order.itemCount}</td>
								<td className="px-6 py-4 text-sm text-black font-acumin">{order.totalAmount}</td>
								<td className="px-6 py-4">
									<span className={`px-3 py-1 text-xs tracking-widest font-acumin ${statusClassMap[order.status]}`}>
										{order.status}
									</span>
								</td>
								<td className="px-6 py-4">
									<div className="flex items-center gap-2">
										{actionLabelMap[order.status] && (
											<button
												onClick={() => handleTransitStatus(order.id)}
												className="px-4 py-2 text-xs tracking-widest transition-all cursor-pointer whitespace-nowrap font-acumin border border-black text-black hover:bg-black hover:text-white"
											>
												{actionLabelMap[order.status]}
											</button>
										)}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
