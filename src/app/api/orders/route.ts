import { NextRequest, NextResponse } from 'next/server';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';

type OrderItemRow = {
	id: string;
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

function toOrderNumber(id: string) {
	return `ORD-${id.slice(0, 8).toUpperCase()}`;
}

export async function GET(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Orders auth error:', userError);
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
		.eq('user_id', user.id)
		.order('created_at', { ascending: false });

	if (error) {
		console.error('Orders fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
	}

	const response = ((data ?? []) as OrderRow[]).map((order) => ({
		id: order.id,
		orderNumber: toOrderNumber(order.id),
		orderDate: formatOrderDate(order.created_at),
		status: mapStatusLabel(order.status),
		totalAmount: formatCurrency(order.total_amount, order.currency),
		itemCount: (order.order_items ?? []).reduce((sum, item) => sum + item.quantity, 0),
		items: (order.order_items ?? []).map((item) => ({
			id: item.id,
			name: item.item_name,
			imageUrl: item.item_image_url,
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			amount: formatCurrency(item.line_total, order.currency),
		})),
		detailHref: `/account/orders/${order.id}`,
	}));

	return NextResponse.json({ data: response });
}