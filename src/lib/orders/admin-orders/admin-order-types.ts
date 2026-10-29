import type { OrderStatus as DbOrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgressKey } from '@/lib/orders/order-progress';
import type { PaymentStatusKey } from '@/lib/orders/payment-status';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';
import type { AdminItemStatus, ItemBlockedReason } from '@/lib/orders/item-state/item-state-types';
import type { ShipmentSlipLink } from '@/lib/orders/shipment-slips/shipment-slip-types';

export const ORDER_ITEM_STATUS_ORDER = ['unpaid', 'payment_expired', 'in_production', 'ready', 'shipped', 'delivered', 'cancel_requested', 'cancelled', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned'] as const satisfies readonly AdminItemStatus[];
export const ORDER_ITEM_PAGE_SIZE = 20;
export const ORDER_ITEM_LIST_ORDER_CAP = 5000;
export const ORDER_ITEM_EXPORT_MAX_ROWS = 20000;

export function orderItemCapNote(cap: number): string {
  return `新しい${cap.toLocaleString('ja-JP')}件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。`;
}

export const ORDER_ITEM_COLUMNS = [
  { key: 'orderNumber', header: '注文ID' }, { key: 'orderCreatedAt', header: '注文日' },
  { key: 'customerName', header: '顧客名' }, { key: 'customerEmail', header: 'メールアドレス' },
  { key: 'itemName', header: '商品名' }, { key: 'color', header: '色' }, { key: 'size', header: 'サイズ' },
  { key: 'quantity', header: '数量' }, { key: 'unitPrice', header: '単価' }, { key: 'lineAmount', header: '合計金額' },
  { key: 'refundAmount', header: '返金額' }, { key: 'status', header: 'ステータス' },
] as const;

export const ADMIN_ORDER_ERRORS: Record<string, readonly [sqlstate: string, status: number, body: string]> = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '注文を見る権限がありません。'],
  GROUP_G_ORDER_NOT_FOUND: ['P0002', 404, '注文が見つかりません。'],
  GROUP_G_EXPORT_TOO_LARGE: ['22023', 422, '条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。'],
};

export const ADMIN_ORDER_TEXT = {
  failed: '注文の情報を読み込めませんでした。',
  listTitle: '注文一覧表', listDescription: '品物ごとに、ステータス別の数量で1行ずつ表示します。行を選ぶと注文の詳細を開きます。',
  empty: '条件に一致する品物はありません。', listLoading: '注文一覧を読み込み中です...', listFailed: '注文一覧を読み込めませんでした。', listForbidden: '注文一覧を見る権限がありません。',
  dateRangeInvalid: '期間指定が不正です。開始日は終了日以前にしてください。',
  export: 'CSV出力', exportDescription: '現在の絞り込みに合う全行を出力します。', exportLoading: 'CSVを作成しています...', exportFailed: 'CSVを出力できませんでした。',
  back: '注文一覧表へ戻る', detailLoading: '注文を読み込み中です...', detailFailed: '注文を読み込めませんでした。', detailNotFound: '注文が見つかりません。', detailForbidden: '注文を見る権限がありません。',
  itemStatesTitle: '品物の状態の変化', itemStatesEmpty: '品物の状態の変化はまだありません。', itemStatesTruncated: '古い変化は省略しています。',
  slipForbidden: '発送票を見る権限がありません。', noFulfillments: 'この注文の発送はまだありません。',
  noAttention: '要対応はありません。', reloadFailed: '最新の状態を読み込めませんでした。', stale: 'この画面の内容は最新ではありません。', reload: '読み込み直す',
} as const;

export type AdminOrderItemFilters = {
  dateFrom?: string; dateTo?: string; orderNumber?: string; customer?: string; email?: string;
  product?: string; color?: string; size?: string; statuses?: AdminItemStatus[]; attention?: boolean;
};
export type AdminOrderExportRow = {
  orderId: string; orderCreatedAt: string; customerName: string | null; customerEmail: string | null;
  orderItemId: string; itemName: string; color: string | null; size: string | null; isExchange: boolean;
  status: AdminItemStatus; quantity: number; unitPrice: number; lineAmount: number; refundAmount: number;
};
export type AdminOrderItemRow = AdminOrderExportRow & { orderNumber: string; blockedReasons: ItemBlockedReason[]; needsAttention: boolean };
export type AdminOrderItemPage = { rows: AdminOrderItemRow[]; totalRows: number; totalOrders: number; ordersCapped: boolean; ordersCap: number; page: number; pageSize: number; totalPages: number };
export type AdminOrderDetailCore = {
  order: {
    id: string; status: DbOrderStatus; createdAt: string; paidAt: string | null; customerKind: 'guest' | 'member';
    customerName: string | null; customerEmail: string | null; currency: string;
    shipTo: { fullName: string | null; postalCode: string | null; prefecture: string | null; city: string | null; address: string | null; building: string | null; phone: string | null };
  };
  amounts: { productNet: number; discount: number; shipping: number; total: number; paidAmount: number | null; refundedAmount: number; refundAttachedToRows: number; refundNotAttached: number; refundProcessingAmount: number };
  rows: Array<Pick<AdminOrderItemRow, 'orderItemId' | 'itemName' | 'color' | 'size' | 'isExchange' | 'status' | 'quantity' | 'unitPrice' | 'lineAmount' | 'refundAmount' | 'blockedReasons'> & { statusRank: number }>;
  attention: {
    paymentExceptions: Array<{ id: string; reason: string; detectionCount: number; firstDetectedAt: string }>;
    review: { reason: string; markedAt: string | null } | null;
    deliveries: Array<{ fulfillmentId: string; kind: string; openedAt: string }>;
    discounts?: import('@/lib/orders/order-payment-types').DiscountAttention[];
  };
  permissions: { read: boolean; manage: boolean; refund: boolean; return: boolean; allocate: boolean; shippingRead: boolean };
};
export type AdminOrderDetail = AdminOrderDetailCore & {
  summary: AdminOrderSummary;
  fulfillments: Array<{ id: string; number: number; shippedAt: string; deliveredAt: string | null; cancelledAt: string | null; carrier: string | null; trackingNumber: string | null; slipId: string | null; slipNumber: string | null }>;
  slips: ShipmentSlipLink[] | null;
};
export type OrderHistoryItemStateEntry = {
  id: string; at: string; orderItemId: string; itemName: string; quantity: number;
  from: AdminItemStatus | null; to: AdminItemStatus | null; reason: string; reasonLabel: string; actorEmail: string | null; automatic: boolean;
  ref: { kind: 'shipment_slip' | 'purchase_order'; id: string; label: string } | null;
  swap: { counterpartOrderId: string; note: string | null } | null;
};

export const ITEM_STATE_REASON_LABELS: Record<string, string> = {
  place_order_from_checkout_draft: '注文の受付', stripe_payment_awaiting: '支払い待ち', stripe_payment_paid: '入金の確認', fifo: '古い注文から順の自動割当', stock_move: '在庫の入出庫', purchase_order_receive: '発注の受け取り',
  shipment_slip_confirm: '発送の確定', shipment_slip_cancel: '発送の取消', shipment_slip_tracking_update: '伝票番号の更新', shipment_slip_deliver: '配達済みの記録', delivery_reflect: '配送の状況の反映',
  begin_order_refund: '返金の受付', mark_order_refund_error: '返金の失敗', admin_cancel_failed_order: '決済失敗の注文の取消', record_cancelled_order_payment: '取消後の入金', resolve_payment_exception: '支払いの要対応の解決', resolve_payment_exception_by_system: '支払いの要対応の解決',
  customer_request_cancel: 'お客様のキャンセルの申し込み', admin_decline_cancel_request: 'キャンセルの申し込みのお断り', admin_close_cancel_request: 'キャンセルの申し込みを閉じる', admin_resolve_cancel_request: 'キャンセルの申し込みの解決',
  customer_request_return: 'お客様の返品の申し込み', admin_create_return: '返品の作成', admin_approve_return: '返品の承認', return_declined_restore: '返品のお断りによる復帰', admin_cancel_return: '返品の取消', admin_receive_return: '返品の受け取り', admin_inspect_return: '返品の検品', admin_close_return_missing: '届かない返品の完了', admin_reopen_return: '返品の開き直し', admin_refund_return: '返品の返金', admin_record_return_fee_payment: '返品の手数料の受け取り', admin_release_return_exchange: '支払いを待たずに交換品を送る', allocation_swap: '割当の入替',
};
export function itemStateReasonLabel(reason: string): string {
  return Object.hasOwn(ITEM_STATE_REASON_LABELS, reason) ? ITEM_STATE_REASON_LABELS[reason] : 'システムによる更新';
}

export type AdminOrderSummary = OrderItem & {
  paymentMethod: string; paymentReference: string; stripePaymentStatus: string | null; paymentStatus: string;
  shippedAt: string | null; shippingCarrier: string | null; trackingNumber: string | null;
};

export type OrderStatus =
	| '支払い手続き中'
	| '未決済'
	| '受注生産中'
	| '発送準備中'
	| '配送中'
	| '配達済み'
	| '決済失敗'
	| '放棄'
	| 'キャンセル'
	| 'キャンセルの手続き中';

export type OrderLineItem = {
	/** 注文の商品の番号。React の key に使う（同じ商品の色違いが重なるため、名前では区別できない） */
	id: string;
	name: string;
	color: string | null;
	size: string | null;
	quantity: number;
	fulfillmentType: 'stock' | 'backorder';
	/** 発送した数 */
	shipped: number;
	/** 受注生産中の数（まだ仕上がっていない数） */
	inProduction: number;
	/** 発送準備中の数（仕上がっていて、まだ送っていない数） */
	readyUnshipped: number;
	/** 返品の交換で足された行は exchange。購入商品の欄に「（交換の品）」を付ける。窓口が付けない昔の形は order と同じに扱う */
	lineKind?: 'order' | 'exchange';
};

export type OrderItem = {
	id: string;
	customerName: string;
	customerEmail: string;
	orderDate: string;
	itemCount: string;
	items: OrderLineItem[];
	totalAmount: string;
	/** 注文の言葉（受注生産中・発送準備中・配送中など）。記録から出した物 */
	status: OrderStatus;
	/** DB の注文の状態。件数・絞り込み・CSV の判断はこれを使う（言葉は表示のため） */
	orderStatus?: DbOrderStatus;
	progressKey?: OrderProgressKey;
	/** 発送した数があり、未発送の数も残っている */
	partiallyShipped?: boolean;
	canRefund?: boolean;
	/** G-1 から窓口は常に false。一覧は見ない（「発送済みにする」は G-1 Task 15 で撤去した） */
	canShip?: boolean;
	/** G-1 から窓口は常に false。一覧は見ない（「仕上がりを記録する」は G-1 Task 15 で撤去した） */
	canRecordCompletion?: boolean;
	missingShippingFields?: string[];
	/** 在庫を確保できなかった入金済みの注文（要確認）。確認済みにするまで印を出す */
	needsReview?: boolean;
	/** 発送できない理由（支払額の違いの要対応）。発送ボタンの代わりに出す */
	shipBlockedReason?: string | null;
	/** キャンセルできる注文（未入金の注文と、支払い済みで1つも発送していない注文。種類は cancelKind） */
	canCancel?: boolean;
	/** 払込票が有効な間は取り消せない。その払込期限（ISO） */
	cancelBlockedUntil?: string | null;
	/** 支払いの言葉の記号（未入金・支払い済み・一部返金など）。言葉と色は「支払い」の列が決める */
	paymentStatusKey?: PaymentStatusKey;
	/** 返事待ち・保留の返金がある（「返金の手続き中」の印） */
	refundPending?: boolean;
	/** 開いている「返金の失敗」の要対応がある（「返金の失敗」の印） */
	refundFailed?: boolean;
	/** 成功した返金の合計（￥12,800）。返金が無ければ - */
	refundedAmountLabel?: string;
	/** キャンセルの種類。unpaid は未入金の取消（取消の画面）、paid は支払い済みのキャンセル（返金を伴う画面）。出さない注文は null */
	cancelKind?: 'unpaid' | 'paid' | null;
	/** 返品の要約（返品の列・小さな印・「返品」のボタンの名前）。窓口が返品の無い注文にも付ける。無い昔の形は返品の無い注文と同じに扱う */
	returnSummary?: OrderReturnSummary;
	/** 開いているキャンセルの申し込みがある（操作の列に「キャンセルの申し込み」のボタンを出す）。窓口が付けない昔の形は、無い注文と同じに扱う */
	cancelRequestOpen?: boolean;
};
