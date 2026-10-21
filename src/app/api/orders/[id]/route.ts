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
import { listOrderRefunds, type OrderRefundRow } from '@/lib/orders/refund/refund-store';
import type { OrderRefundStatus } from '@/lib/orders/refund/refund-types';
import { konbiniDeadlineLastDay } from '@/lib/orders/refund/refund-messages';
import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';
import { loadCustomerOrderReturns } from '@/lib/orders/returns/customer-return-store';
import type { CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import { isDeliveryTrackingKeyConfigured } from '@/lib/orders/tracking/delivery-config';
import { getOrderDeliveryDetail, listOrderDeliverySummaries } from '@/lib/orders/tracking/delivery-store';
import type {
	CustomerDelivery,
	FulfillmentDeliveryDetail,
	OrderDeliveryDetail,
	OrderDeliverySummary,
} from '@/lib/orders/tracking/delivery-types';

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
	// 'exchange' は返品の交換でお店が足した品の行（値段は 0）。画面が「交換の品」の印を付け、値段を「—」にする
	line_kind: 'order' | 'exchange';
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

type CustomerRefundStatus = 'processing' | 'completed';

// お客様に見せる返金の状態。返事待ち・保留は手続き中、成功は完了。エラー・失敗は入れない（店が連絡するため。設計書 9-3）
const CUSTOMER_REFUND_STATUSES: Partial<Record<OrderRefundStatus, CustomerRefundStatus>> = {
	awaiting_response: 'processing',
	pending: 'processing',
	succeeded: 'completed',
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

// 返金の日付は日本時間の日付だけ（注文日時の書き方から時刻を除いた「2026/10/12」）
function formatRefundDate(dateText: string) {
	const date = new Date(dateText);
	if (Number.isNaN(date.getTime())) {
		return '-';
	}

	return new Intl.DateTimeFormat('ja-JP', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: 'Asia/Tokyo',
	}).format(date);
}

// 口座の入力が必ず間に合う最後の日は、メールと同じ部品で決める。ここでは「M月D日」の書き方だけを持つ
function formatMonthDay(dateText: string) {
	const deadline = konbiniDeadlineLastDay(dateText);
	return deadline ? `${deadline.month}月${deadline.day}日` : null;
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
 * お客様に見せる配送の状況。現版（今の伝票番号）の出来事だけを、新しい順に、状況と時刻の2項目で返す。
 * 管理者のメール・17TRACK の細かい状況・登録の状態・旧版の出来事は、名指しで選んだ項目に入らないので渡らない。
 */
function toCustomerDelivery(detail: FulfillmentDeliveryDetail): CustomerDelivery {
	return {
		status: detail.deliveryStatus,
		statusAt: detail.deliveryStatusAt,
		events: detail.events
			.filter((event) => event.trackingVersion === detail.trackingVersion)
			.sort((a, b) => Date.parse(b.happenedAt) - Date.parse(a.happenedAt) || Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
			.map((event) => ({ status: event.status, happenedAt: event.happenedAt })),
	};
}

/**
 * お客様に見せる発送。取り消していない分だけを、1回目から古い順に返す。
 * 操作した管理者のメールなど内側の情報は、名指しで選んだ項目以外は渡さない。
 * 前からの記録で配送業者・伝票番号が空でも、知らない配送業者の記号でも、落とさずに空で返す。
 * 配達済みの時刻 deliveredAt は、追跡のオン・オフや鍵の有無によらずいつも付ける（手で付けた配達済みも出す）。
 * 配送の状況 delivery は、追跡オンで鍵があり、その発送の現版の登録が追跡中（registered）か、一度でも登録できてから止めた（stopped かつ ever_registered）時だけ付け、
 * 合わない時は null ではなくキーごと省く
 * （登録待ち・登録できない発送が、ずっと「受付済み」や止まった「輸送中」に見えるのを防ぐ。設計書 7-1）。
 */
function toShipments(
	fulfillments: readonly OrderFulfillmentHistoryRow[],
	items: readonly OrderItemRow[],
	deliveryDetail: OrderDeliveryDetail,
	trackingKeyConfigured: boolean,
) {
	const itemById = new Map<string, OrderItemRow>(items.map((item) => [item.id, item]));
	// 取り消した発送の記録は、2回の読み取りの間に取り消された場合も含めて、使わない
	const deliveryByFulfillment = new Map<string, FulfillmentDeliveryDetail>(
		deliveryDetail.fulfillments
			.filter((detail) => detail.cancelledAt === null)
			.map((detail) => [detail.fulfillmentId, detail]),
	);
	const canShowDelivery = deliveryDetail.enabled && trackingKeyConfigured;

	return fulfillments
		.filter((fulfillment) => fulfillment.cancelledAt === null)
		.sort((a, b) => a.number - b.number)
		.map((fulfillment) => {
			const carrier = isShippingCarrierId(fulfillment.shippingCarrier)
				? SHIPPING_CARRIERS[fulfillment.shippingCarrier]
				: null;
			const delivery = deliveryByFulfillment.get(fulfillment.fulfillmentId);
			const registration = delivery?.registration;
			// 追跡中（registered）か、一度でも登録できてから止めた（stopped かつ everRegistered）発送だけ。
			// 一度も登録できずに止まった行（登録前に期限切れ・オフで止めた後に期限切れ など）は、出来事が発送の時の「受付済み」だけで
			// ずっと「受付済み」に見えるので、追跡のリンクだけにする（設計書 7-1）
			const trackedByProvider =
				registration?.state === 'registered' || (registration?.state === 'stopped' && registration.everRegistered);

			return {
				id: fulfillment.fulfillmentId,
				number: fulfillment.number,
				shippedAt: fulfillment.shippedAt,
				carrier: fulfillment.shippingCarrier,
				carrierLabel: carrier?.label ?? null,
				trackingNumber: fulfillment.trackingNumber,
				trackingUrl:
					carrier && fulfillment.trackingNumber ? carrier.trackingUrl(fulfillment.trackingNumber) : null,
				deliveredAt: delivery?.deliveredAt ?? null,
				...(canShowDelivery && delivery && trackedByProvider ? { delivery: toCustomerDelivery(delivery) } : {}),
				items: fulfillment.lines.flatMap((line) => {
					const item = itemById.get(line.orderItemId);
					return item
						? [{ orderItemId: item.id, name: item.item_name, color: item.color, size: item.size, quantity: line.quantity, lineKind: item.line_kind }]
						: [];
				}),
			};
		});
}

/**
 * お客様に見せる返金と、その合計。返金は古い順に返す（DB の関数は新しい順に返す）。
 * 返事待ち・保留は手続き中、成功は完了。エラー・失敗は入れない（店が連絡する）。
 * 項目は名指しで選び、操作した人のメール・メモ・照会番号・失敗の理由など内側の情報は渡さない。
 */
function toCustomerRefunds(rows: readonly OrderRefundRow[], currency: string) {
	const shown = rows
		.flatMap((row) => {
			const status = CUSTOMER_REFUND_STATUSES[row.status];
			return status ? [{ row, status }] : [];
		})
		.sort((a, b) => Date.parse(a.row.createdAt) - Date.parse(b.row.createdAt));

	return {
		refunds: shown.map(({ row, status }) => ({
			id: row.refundId,
			date: formatRefundDate(row.createdAt),
			amount: formatCurrency(row.amount, currency),
			status,
			// コンビニ払いは、お客様が返金先の口座を入れるまで保留のまま。入力の期限を知らせる
			customerActionDeadline:
				row.status === 'pending' && row.paymentMethodType === 'konbini' && row.customerActionExpiresAt
					? formatMonthDay(row.customerActionExpiresAt)
					: null,
		})),
		// 合計は、出している返金の額の和（画面の行を足すと合計になる）。1件だけの時は出さない
		refundTotal:
			shown.length >= 2
				? formatCurrency(shown.reduce((total, { row }) => total + row.amount, 0), currency)
				: null,
	};
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

	// 返事待ち・保留の返金がある間は、全部の商品を返金した注文を「キャンセルの手続き中」と出す
	const hasOpenRefund = refundRows.some((row) => row.status === 'awaiting_response' || row.status === 'pending');
	const progress = deriveOrderProgress(data.status, lineRows, { hasOpenRefund, delivery: deliverySummary });
	const lineByItemId = new Map<string, OrderLineFulfillmentRow>(lineRows.map((row) => [row.orderItemId, row]));
	const showStages = STAGE_VISIBLE_STATUSES.includes(data.status);
	const { refunds, refundTotal } = toCustomerRefunds(refundRows, data.currency);

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
		shipments: toShipments(fulfillments, data.order_items ?? [], deliveryDetail, isDeliveryTrackingKeyConfigured(process.env)),
		refunds,
		refundTotal,
		returnSection,
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
				// 'exchange' は交換の品の行。金額は DB の値（¥0）のまま返し、「—」にするのは画面
				lineKind: item.line_kind,
				shippedQuantity: line?.shipped ?? 0,
				// 返事待ち・保留・成功の返金の数（発送前と発送後の合計）。数え方は DB の1か所にある
				refundedQuantity: (line?.refundedBeforeShipment ?? 0) + (line?.refundedAfterShipment ?? 0),
				readyQuantity: showStages ? (line?.readyUnshipped ?? 0) : 0,
				inProductionQuantity: showStages ? (line?.inProduction ?? 0) : 0,
			};
		})),
	}, { headers: NO_STORE_HEADERS });
}