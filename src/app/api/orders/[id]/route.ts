import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
import { buildCustomerOrderDetailView } from '@/lib/orders/customer-order-view';
import type { CustomerOrderDetailInput } from '@/lib/orders/customer-order-view-types';
import {
	listOrderFulfillments,
	listOrderLineFulfillment,
	type OrderFulfillmentHistoryRow,
	type OrderLineFulfillmentRow,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { listOrderRefunds, type OrderRefundRow } from '@/lib/orders/refund/refund-store';
import { loadCustomerOrderReturns } from '@/lib/orders/returns/customer-return-store';
import type { CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import { isDeliveryTrackingKeyConfigured } from '@/lib/orders/tracking/delivery-config';
import { getOrderDeliveryDetail, listOrderDeliverySummaries } from '@/lib/orders/tracking/delivery-store';
import type { OrderDeliveryDetail, OrderDeliverySummary } from '@/lib/orders/tracking/delivery-types';

const NO_STORE_HEADERS = {
	'Cache-Control': 'no-store',
};

type OrderDetailRow = CustomerOrderDetailInput['order'] & { payment_intent_id: string | null };

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
				line_total,
				line_kind
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
	let deliverySummary: OrderDeliverySummary | undefined;
	let deliveryDetail: OrderDeliveryDetail;
	try {
		// 配送の集計と配送の記録も同じ client で読む。読めない時は 500 にする（空の履歴で偽の「配送中」や「配達済み」にしない）
		const [lineRowsByOrder, fulfillmentRows, deliverySummaries, deliveryRows] = await Promise.all([
			listOrderLineFulfillment(serviceSupabase, [data.id]),
			listOrderFulfillments(serviceSupabase, data.id),
			listOrderDeliverySummaries(serviceSupabase, [data.id]),
			getOrderDeliveryDetail(serviceSupabase, data.id),
		]);
		lineRows = lineRowsByOrder.get(data.id) ?? [];
		fulfillments = fulfillmentRows;
		deliverySummary = deliverySummaries.get(data.id);
		deliveryDetail = deliveryRows;
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

	// 返金も、持ち主の確かめを通った注文だけ service_role で読む（返金の表もお客様から直接読めない）
	let refundRows: OrderRefundRow[];
	try {
		refundRows = await listOrderRefunds(serviceSupabase, data.id);
	} catch (refundError) {
		// 読めないまま返金の無い画面にすると、手続き中の返金がある注文が「発送準備中」と出る。隠さず 500 にする。
		// 発送の読み取りと同じく、DB の文は出さず、名前・code・operation だけを残す
		console.error(
			'Order refund fetch error:',
			refundError instanceof Error ? refundError.name : 'UnknownError',
			(refundError as { code?: unknown })?.code ?? null,
			(refundError as { operation?: unknown })?.operation ?? null,
		);
		return NextResponse.json({ error: 'Failed to fetch order detail' }, { status: 500, headers: NO_STORE_HEADERS });
	}

	// 返品・交換の欄（グループ E-3 段2）。読めなくても注文の答えは返し、欄だけ null にする（画面は欄を出さない）。
	// 持ち主の確かめはこの窓口で済んでいる。DB の関数は、お客様に隠す状態の注文なら null で答える
	let returnSection: CustomerOrderReturns | null = null;
	try {
		returnSection = await loadCustomerOrderReturns(serviceSupabase, { orderId: data.id, customerId: userId });
	} catch (returnError) {
		// ログには誤りの名前だけを残す（DB の文には宛先・氏名などが混ざりうる）
		console.error('Order return section fetch error:', returnError instanceof Error ? returnError.name : 'UnknownError');
	}

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

	const view = await buildCustomerOrderDetailView({
		order: data, lineRows, fulfillments, deliverySummary, deliveryDetail, refundRows, returnSection, paymentMethod,
		trackingKeyConfigured: isDeliveryTrackingKeyConfigured(process.env),
		signImage: (path) => signItemImageUrl(serviceSupabase, path),
	});
	return NextResponse.json(view, { headers: NO_STORE_HEADERS });
}
