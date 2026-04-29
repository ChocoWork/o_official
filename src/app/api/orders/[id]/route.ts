import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';
import { signItemImageUrl } from '@/lib/storage/item-images';

type OrderItemRow = {
	id: string;
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
	status: 'pending' | 'paid' | 'failed' | 'cancelled';
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

function mapStatusLabel(status: OrderDetailRow['status']) {
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

function toOrderNumber(id: string) {
	return `ORD-${id.slice(0, 8).toUpperCase()}`;
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
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Order detail auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
			shipping_postal_code,
			shipping_prefecture,
			shipping_city,
			shipping_address,
			shipping_building,
			shipping_phone,
			order_items (
				id,
				item_name,
				item_image_url,
				color,
				size,
				quantity,
				line_total
			)
		`)
		.eq('id', id)
		.eq('user_id', user.id)
		.maybeSingle<OrderDetailRow>();

	if (error) {
		console.error('Order detail fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500 });
	}

	if (!data) {
		return NextResponse.json({ error: 'Order not found' }, { status: 404 });
	}

	const signSupabase = await createServiceRoleClient();

	return NextResponse.json({
		id: data.id,
		orderNumber: toOrderNumber(data.id),
		orderDate: formatOrderDate(data.created_at),
		status: mapStatusLabel(data.status),
		totalAmount: formatCurrency(data.total_amount, data.currency),
		shippingFullName: data.shipping_full_name ?? '',
		shippingEmail: data.shipping_email ?? '',
		shippingPhone: data.shipping_phone ?? '',
		shippingAddress: toShippingAddress(data),
		items: await Promise.all((data.order_items ?? []).map(async (item) => ({
			id: item.id,
			name: item.item_name,
			imageUrl: await signItemImageUrl(signSupabase, item.item_image_url),
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, data.currency),
		}))),
	});
}