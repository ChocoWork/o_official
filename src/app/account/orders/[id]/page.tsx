'use client';

import Link from 'next/link';
import React from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useLogin } from '@/contexts/LoginContext';
import { clientFetch } from '@/lib/client-fetch';

type OrderDetail = {
	id: string;
	orderNumber: string;
	orderDate: string;
	status: string;
	totalAmount: string;
	shippingFullName: string;
	shippingEmail: string;
	shippingPhone: string;
	shippingAddress: string;
	items: Array<{
		id: string;
		name: string;
		imageUrl?: string | null;
		color?: string | null;
		size?: string | null;
		quantity: number;
		amount: string;
	}>;
};

export default function AccountOrderDetailPage() {
	const params = useParams<{ id: string }>();
	const { isLoggedIn, isAuthResolved } = useLogin();
	const [order, setOrder] = React.useState<OrderDetail | null>(null);
	const [isLoading, setIsLoading] = React.useState(true);
	const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!isAuthResolved || !isLoggedIn || !params.id) {
			setIsLoading(false);
			return;
		}

		const fetchOrderDetail = async () => {
			setIsLoading(true);
			setErrorMessage(null);

			try {
				const response = await clientFetch(`/api/orders/${params.id}`, { cache: 'no-store' });
				if (!response.ok) {
					throw new Error('注文詳細の取得に失敗しました');
				}

				const data = (await response.json()) as OrderDetail;
				setOrder(data);
			} catch (error) {
				console.error('Failed to fetch order detail:', error);
				setErrorMessage('注文詳細を読み込めませんでした');
			} finally {
				setIsLoading(false);
			}
		};

		void fetchOrderDetail();
	}, [isAuthResolved, isLoggedIn, params.id]);

	if (!isAuthResolved) {
		return (
			<div className="pb-10 sm:pb-14 px-6 lg:px-12">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-lg text-[#474747] mb-8 font-brand">読み込み中...</p>
				</div>
			</div>
		);
	}

	if (!isLoggedIn) {
		return (
			<div className="pb-10 sm:pb-14 px-6 lg:px-12">
				<div className="max-w-3xl mx-auto text-center">
					<h1 className="text-4xl text-black tracking-tight mb-4 font-display">注文詳細</h1>
					<p className="text-lg text-[#474747] mb-8 font-brand">注文詳細を確認するにはログインが必要です</p>
					<Button href="/login" variant="primary" size="lg" className="font-brand">
						ログイン
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="pb-10 sm:pb-14 px-6 lg:px-12">
			<div className="max-w-4xl mx-auto space-y-6">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h1 className="text-4xl text-black tracking-tight mb-2 font-display">注文詳細</h1>
						<p className="text-sm text-[#474747] font-brand">ご注文内容と配送先情報を確認できます。</p>
					</div>
					<Link href="/account?tab=orders" className="text-sm text-black underline underline-offset-4 font-brand">
						購入履歴へ戻る
					</Link>
				</div>

				{isLoading ? <p className="text-sm text-[#474747] font-brand">注文詳細を読み込み中...</p> : null}
				{errorMessage ? <p className="text-sm text-red-600 font-brand">{errorMessage}</p> : null}

				{order ? (
					<div className="space-y-6">
						<section className="border border-black/10 p-8 space-y-4">
							<div className="grid gap-4 sm:grid-cols-2">
								<div>
									<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">注文番号</p>
									<p className="text-lg text-black font-brand">{order.orderNumber}</p>
								</div>
								<div>
									<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">注文日</p>
									<p className="text-sm text-black font-brand">{order.orderDate}</p>
								</div>
								<div>
									<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">ステータス</p>
									<p className="text-sm text-black font-brand">{order.status}</p>
								</div>
								<div>
									<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">合計</p>
									<p className="text-xl text-black font-display">{order.totalAmount}</p>
								</div>
							</div>
						</section>

						<section className="border border-black/10 p-8 space-y-4">
							<h2 className="text-2xl text-black tracking-tight font-display">ご注文商品</h2>
							<div className="space-y-4">
								{order.items.map((item) => (
									<div key={item.id} className="border-b border-black/5 pb-4 last:border-b-0 last:pb-0">
										<p className="text-sm text-black font-brand">{item.name}</p>
										<p className="text-xs text-[#474747] font-brand">
											数量: {item.quantity}
											{item.color ? ` / カラー: ${item.color}` : ''}
											{item.size ? ` / サイズ: ${item.size}` : ''}
										</p>
										<p className="text-sm text-black font-brand">{item.amount}</p>
									</div>
								))}
							</div>
						</section>

						<section className="border border-black/10 p-8 space-y-4">
							<h2 className="text-2xl text-black tracking-tight font-display">配送先情報</h2>
							<div className="space-y-2 text-sm text-black font-brand">
								<p>{order.shippingFullName || '-'}</p>
								<p>{order.shippingEmail || '-'}</p>
								<p>{order.shippingPhone || '-'}</p>
								<p>{order.shippingAddress || '-'}</p>
							</div>
						</section>
					</div>
				) : null}
			</div>
		</div>
	);
}