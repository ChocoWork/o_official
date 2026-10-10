import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { toOrderNumber } from '@/lib/orders/order-number';
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
import { buildOrderProgressSteps, deriveOrderProgress } from '@/lib/orders/order-progress';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
	listOrderFulfillments,
	listOrderLineFulfillment,
	type OrderFulfillmentHistoryRow,
	type OrderLineFulfillmentRow,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';

const NO_STORE_HEADERS = {
	'Cache-Control': 'no-store',
};

type OrderItemRow = {
	id: string;
	item_id: number | null;
	// 再注文でカートに入れるバリアント。バリアントの番号を持たない古い明細は null
	variant_id: number | null;
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
	order_items: OrderItemRow[] | null;
};

// 商品の段階（発送準備中・受注生産中）は、入金後の注文にだけ出す。未入金・失敗・キャンセルの注文の品を「発送準備中」と見せないため
const STAGE_VISIBLE_STATUSES: ReadonlyArray<OrderDetailRow['status']> = ['paid', 'shipped'];

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

/**
 * お客様に見せる発送。取り消していない分だけを、1回目から古い順に返す。
 * 操作した管理者のメールなど内側の情報は、名指しで選んだ項目以外は渡さない。
 * 前からの記録で配送業者・伝票番号が空でも、知らない配送業者の記号でも、落とさずに空で返す。
 */
function toShipments(fulfillments: readonly OrderFulfillmentHistoryRow[], items: readonly OrderItemRow[]) {
	const itemById = new Map<string, OrderItemRow>(items.map((item) => [item.id, item]));

	return fulfillments
		.filter((fulfillment) => fulfillment.cancelledAt === null)
		.sort((a, b) => a.number - b.number)
		.map((fulfillment) => {
			const carrier = isShippingCarrierId(fulfillment.shippingCarrier)
				? SHIPPING_CARRIERS[fulfillment.shippingCarrier]
				: null;

			return {
				id: fulfillment.fulfillmentId,
				number: fulfillment.number,
				shippedAt: fulfillment.shippedAt,
				carrier: fulfillment.shippingCarrier,
				carrierLabel: carrier?.label ?? null,
				trackingNumber: fulfillment.trackingNumber,
				trackingUrl:
					carrier && fulfillment.trackingNumber ? carrier.trackingUrl(fulfillment.trackingNumber) : null,
				items: fulfillment.lines.flatMap((line) => {
					const item = itemById.get(line.orderItemId);
					return item
						? [{ orderItemId: item.id, name: item.item_name, color: item.color, size: item.size, quantity: line.quantity }]
						: [];
				}),
			};
		});
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
			order_items (
				id,
				item_id,
				variant_id,
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
		// メールで知らせた注文だけを見せる（支払い手続き中・放棄は出さない。設計書 5-5）
		.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
		.maybeSingle<OrderDetailRow>();

	if (error) {
		console.error('Order detail fetch error:', error);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	if (!data) {
		return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE_HEADERS });
	}

	// ここから先は持ち主の確かめを通った注文だけ。発送と数の新しい表はお客様から直接読めないので service_role で読む
	const serviceSupabase = await createServiceRoleClient();

	let lineRows: OrderLineFulfillmentRow[];
	let fulfillments: OrderFulfillmentHistoryRow[];
	try {
		const [lineRowsByOrder, fulfillmentRows] = await Promise.all([
			listOrderLineFulfillment(serviceSupabase, [data.id]),
			listOrderFulfillments(serviceSupabase, data.id),
		]);
		lineRows = lineRowsByOrder.get(data.id) ?? [];
		fulfillments = fulfillmentRows;
	} catch (fulfillmentError) {
		// DB の文には宛先などが混ざりうるので、エラーの中身は出さず、名前・code・operation だけを残す
		console.error(
			'Order fulfillment fetch error:',
			fulfillmentError instanceof Error ? fulfillmentError.name : 'UnknownError',
			(fulfillmentError as { code?: unknown })?.code ?? null,
			(fulfillmentError as { operation?: unknown })?.operation ?? null,
		);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	const progress = deriveOrderProgress(data.status, lineRows);
	const lineByItemId = new Map<string, OrderLineFulfillmentRow>(lineRows.map((row) => [row.orderItemId, row]));
	const showStages = STAGE_VISIBLE_STATUSES.includes(data.status);

	// 支払方法（checkout_drafts に注文確定時の payment_intent_id が書き戻されている）
	let paymentMethod: string | null = null;
	if (data.payment_intent_id) {
		const { data: draftRow } = await serviceSupabase
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
		// DB の状態の値。画面の言葉と段は progress を使う
		status: data.status,
		progress: { ...progress, steps: buildOrderProgressSteps(progress, lineRows) },
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
		shipments: toShipments(fulfillments, data.order_items ?? []),
		items: await Promise.all((data.order_items ?? []).map(async (item) => {
			const line = lineByItemId.get(item.id);
			return {
				id: item.id,
				itemId: item.item_id,
				variantId: item.variant_id ?? null,
				name: item.item_name,
				imageUrl: await signItemImageUrl(serviceSupabase, item.item_image_url),
				color: item.color,
				size: item.size,
				quantity: item.quantity,
				amount: formatCurrency(item.line_total, data.currency),
				shippedQuantity: line?.shipped ?? 0,
				readyQuantity: showStages ? (line?.readyUnshipped ?? 0) : 0,
				inProductionQuantity: showStages ? (line?.inProduction ?? 0) : 0,
			};
		})),
	}, { headers: NO_STORE_HEADERS });
}