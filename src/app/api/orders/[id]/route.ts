import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { toOrderNumber } from '@/lib/orders/order-number';
import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';

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

type OrderDetailRow = {
	id: string;
	created_at: string;
	status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
	payment_intent_id: string | null;
	subtotal_amount: number;
	shipping_amount: number;
	discount_amount: number;
	total_amount: number;
	currency: string;
	shipping_full_name: string | null;
	shipping_email: string | null;
	shipping_postal_code: string | null;
	shipping_prefecture: string | null;
	shipping_city: string | null;
	shipping_address: string | null;
	shipping_building: string | null;
	shipping_phone: string | null;
	shipped_at: string | null;
	shipping_carrier: string | null;
	tracking_number: string | null;
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

// 注文詳細は日付に加えて時刻（日本時間）も表示する
function formatOrderDateTime(dateText: string) {
	const date = new Date(dateText);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}

	return new Intl.DateTimeFormat('ja-JP', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Asia/Tokyo',
	}).format(date);
}

function toShippingAddress(order: OrderDetailRow) {
	return [
		order.shipping_postal_code ? `〒${order.shipping_postal_code}` : '',
		order.shipping_prefecture ?? '',
		order.shipping_city ?? '',
		order.shipping_address ?? '',
		order.shipping_building ?? '',
	]
		.filter(Boolean)
		.join(' ')
		.trim();
}

export async function GET(
	request: NextRequest,
	context: { params: Promise<{ id: string }> },
) {
	const { id } = await context.params;
	const supabase = await createClient(request);
	const auth = await authenticateRequest(request);

	if (!auth.ok) {
		console.warn('Order detail auth error:', auth.reason);
		return authFailureResponse(auth.reason, NO_STORE_HEADERS);
	}

	const userId = auth.claims.sub;

	const { data, error } = await supabase
		.from('orders')
		.select(`
			id,
			created_at,
			status,
			payment_intent_id,
			subtotal_amount,
			shipping_amount,
			discount_amount,
			total_amount,
			currency,
			shipping_full_name,
			shipping_email,
			shipping_postal_code,
			shipping_prefecture,
			shipping_city,
			shipping_address,
			shipping_building,
			shipping_phone,
			shipped_at,
			shipping_carrier,
			tracking_number,
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
		.eq('id', id)
		.eq('user_id', userId)
		.maybeSingle<OrderDetailRow>();

	if (error) {
		console.error('Order detail fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	if (!data) {
		return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE_HEADERS });
	}

	const signSupabase = await createServiceRoleClient();

	// 支払方法（checkout_drafts に注文確定時の payment_intent_id が書き戻されている）
	let paymentMethod: string | null = null;
	if (data.payment_intent_id) {
		const { data: draftRow } = await signSupabase
			.from('checkout_drafts')
			.select('payment_method')
			.eq('payment_intent_id', data.payment_intent_id)
			.limit(1)
			.maybeSingle<{ payment_method: string }>();
		paymentMethod = draftRow?.payment_method ?? null;
	}

	return NextResponse.json({
		id: data.id,
		orderNumber: toOrderNumber(data.id),
		orderDate: formatOrderDateTime(data.created_at),
		// 画面側の formatOrderStatus / resolveOrderProgressIndex が raw status 前提のためそのまま返す
		status: data.status,
		subtotalAmount: formatCurrency(data.subtotal_amount, data.currency),
		shippingAmount: formatCurrency(data.shipping_amount, data.currency),
		discountAmount:
			data.discount_amount > 0
				? `-${formatCurrency(data.discount_amount, data.currency)}`
				: formatCurrency(0, data.currency),
		totalAmount: formatCurrency(data.total_amount, data.currency),
		paymentMethod: mapPaymentMethodLabel(paymentMethod),
		shippingFullName: data.shipping_full_name ?? '',
		shippingEmail: data.shipping_email ?? '',
		shippingPhone: data.shipping_phone ?? '',
		shippingAddress: toShippingAddress(data),
		shippedAt: data.shipped_at,
		shippingCarrier: data.shipping_carrier,
		trackingNumber: data.tracking_number,
		items: await Promise.all((data.order_items ?? []).map(async (item) => ({
			id: item.id,
			itemId: item.item_id,
			name: item.item_name,
			imageUrl: await signItemImageUrl(signSupabase, item.item_image_url),
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, data.currency),
		}))),
	}, { headers: NO_STORE_HEADERS });
}