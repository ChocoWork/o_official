import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { toOrderNumber } from '@/lib/orders/order-number';

const NO_STORE_HEADERS = {
	'Cache-Control': 'no-store',
};

type OrderItemRow = {
	id: string;
	item_id: number | null;
	item_name: string;
	item_image_url: string | null;
	color: string | null;
	size: string | null;
	quantity: number;
	line_total: number;
};

type OrderRow = {
	id: string;
	created_at: string;
	status: 'pending' | 'paid' | 'failed' | 'cancelled';
	total_amount: number;
	currency: string;
	shipping_full_name: string | null;
	shipping_email: string | null;
	shipping_phone: string | null;
	shipping_postal_code: string | null;
	shipping_prefecture: string | null;
	shipping_city: string | null;
	shipping_address: string | null;
	shipping_building: string | null;
	order_items: OrderItemRow[] | null;
};

type StockStatus = 'in_stock' | 'low_stock' | 'sold_out' | 'unknown';

function toStockStatus(qty: number | null): StockStatus {
	if (qty === null) return 'unknown';
	if (qty === 0) return 'sold_out';
	if (qty <= 4) return 'low_stock';
	return 'in_stock';
}

function formatCurrency(amount: number, currency: string) {
	try {
		return new Intl.NumberFormat('ja-JP', {
			style: 'currency',
			currency: currency.toUpperCase(),
			maximumFractionDigits: 0,
		}).format(amount);
	} catch {
		return `¥${amount.toLocaleString('ja-JP')}`;
	}
}

function formatOrderDate(dateText: string) {
	const date = new Date(dateText);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}

	return new Intl.DateTimeFormat('ja-JP', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

function mapStatusLabel(status: OrderRow['status']) {
	if (status === 'paid') {
		return '決済完了';
	}

	if (status === 'failed') {
		return '決済失敗';
	}

	if (status === 'cancelled') {
		return 'キャンセル';
	}

	return '未決済';
}

function formatShippingAddress(order: OrderRow): string {
	return [
		order.shipping_postal_code ? `〒${order.shipping_postal_code}` : null,
		order.shipping_prefecture,
		order.shipping_city,
		order.shipping_address,
		order.shipping_building,
	]
		.filter(Boolean)
		.join(' ');
}

export async function GET(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Orders auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
	}

	const { data, error } = await supabase
		.from('orders')
		.select(`
			id,
			created_at,
			status,
			total_amount,
			currency,
			shipping_full_name,
			shipping_email,
			shipping_phone,
			shipping_postal_code,
			shipping_prefecture,
			shipping_city,
			shipping_address,
			shipping_building,
			order_items (
				id,
				item_id,
				item_name,
				item_image_url,
				color,
				size,
				quantity,
				line_total
			)
		`)
		.eq('user_id', user.id)
		.order('created_at', { ascending: false });

	if (error) {
		console.error('Orders fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	// 全注文に含まれるitem_idを収集してまとめて在庫照会
	const allItemIds = [
		...new Set(
			((data ?? []) as OrderRow[])
				.flatMap((o) => (o.order_items ?? []).map((i) => i.item_id))
				.filter((id): id is number => id !== null),
		),
	];

	const signSupabase = await createServiceRoleClient();

	const stockMap = new Map<number, StockStatus>();
	if (allItemIds.length > 0) {
		const { data: stockRows } = await signSupabase
			.from('items')
			.select('id, stock_quantity')
			.in('id', allItemIds);
		for (const row of stockRows ?? []) {
			stockMap.set(row.id, toStockStatus(row.stock_quantity));
		}
	}

	const response = await Promise.all(((data ?? []) as OrderRow[]).map(async (order) => ({
		id: order.id,
		orderNumber: toOrderNumber(order.id),
		orderDate: formatOrderDate(order.created_at),
		status: mapStatusLabel(order.status),
		totalAmount: formatCurrency(order.total_amount, order.currency),
		itemCount: (order.order_items ?? []).reduce((sum, item) => sum + item.quantity, 0),
		shippingFullName: order.shipping_full_name ?? '',
		shippingEmail: order.shipping_email ?? '',
		shippingPhone: order.shipping_phone ?? '',
		shippingAddress: formatShippingAddress(order),
		items: await Promise.all((order.order_items ?? []).map(async (item) => ({
			id: item.id,
			itemId: item.item_id,
			name: item.item_name,
			imageUrl: await signItemImageUrl(signSupabase, item.item_image_url),
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, order.currency),
			stockStatus: item.item_id !== null ? (stockMap.get(item.item_id) ?? 'unknown') : 'unknown',
		}))),
		detailHref: `/account/orders/${order.id}`,
	})));

	return NextResponse.json({ data: response }, { headers: NO_STORE_HEADERS });
}
