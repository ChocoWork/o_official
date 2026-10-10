import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { toOrderNumber } from '@/lib/orders/order-number';
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';

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
	status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
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
	const auth = await authenticateRequest(request);

	if (!auth.ok) {
		console.warn('Orders auth error:', auth.reason);
		return authFailureResponse(auth.reason, NO_STORE_HEADERS);
	}

	const userId = auth.claims.sub;

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
		.eq('user_id', userId)
		// メールで知らせた注文だけを見せる（支払い手続き中・放棄は出さない。設計書 5-5）
		.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
		.order('created_at', { ascending: false });

	if (error) {
		console.error('Orders fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const orders = (data ?? []) as OrderRow[];
	const serviceSupabase = await createServiceRoleClient();

	// 一覧の言葉は商品の数から出す。新しい表はお客様から直接読めないので、持ち主の確かめを通った一覧の分を service_role で1回で読む
	let lineRowsByOrder: Map<string, OrderLineFulfillmentRow[]>;
	try {
		lineRowsByOrder = await listOrderLineFulfillment(serviceSupabase, orders.map((order) => order.id));
	} catch (fulfillmentError) {
		// DB の文には宛先などが混ざりうるので、エラーの中身は出さず、名前・code・operation だけを残す
		console.error(
			'Orders fulfillment fetch error:',
			fulfillmentError instanceof Error ? fulfillmentError.name : 'UnknownError',
			(fulfillmentError as { code?: unknown })?.code ?? null,
			(fulfillmentError as { operation?: unknown })?.operation ?? null,
		);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const response = await Promise.all(orders.map(async (order) => ({
		id: order.id,
		orderNumber: toOrderNumber(order.id),
		orderDate: formatOrderDate(order.created_at),
		status: deriveOrderProgress(order.status, lineRowsByOrder.get(order.id) ?? []).label,
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
			imageUrl: await signItemImageUrl(serviceSupabase, item.item_image_url),
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, order.currency),
		}))),
		detailHref: `/account/orders/${order.id}`,
	})));

	return NextResponse.json({ data: response }, { headers: NO_STORE_HEADERS });
}
