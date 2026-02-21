'use client';

export type OrderStatus = '未出荷' | '準備中' | '出荷完了' | '配達完了' | 'キャンセル';

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	totalAmount: string;
	status: OrderStatus;
};

const actionLabelMap: Partial<Record<OrderStatus, string>> = {
	未出荷: '準備開始',
	準備中: '出荷完了',
	出荷完了: '配達完了',
};

interface OrderSectionProps {
	orders: OrderItem[];
	onTransitStatus: (id: string) => void;
}

export default function OrderSection({ orders, onTransitStatus }: OrderSectionProps) {

	const statusClassMap: Record<OrderStatus, string> = {
		未出荷: 'bg-red-100 text-red-800',
		準備中: 'bg-yellow-100 text-yellow-800',
		出荷完了: 'bg-blue-100 text-blue-800',
		配達完了: 'bg-green-100 text-green-800',
		キャンセル: 'bg-gray-100 text-gray-500',
	};

	return (
		<section>
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
												onClick={() => onTransitStatus(order.id)}
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
