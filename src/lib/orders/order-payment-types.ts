/**
 * 注文と支払いの照合で使う値（グループ A 設計書 4-2・4-4・5-2）。
 * DB の enum・CHECK 制約と同じ値を1か所に置く。変えるときはマイグレーションと一緒に変える
 * （tests/unit/lib/orders/order-payment-types.test.ts が突き合わせる）。
 */
export const ORDER_STATUSES = [
  'payment_in_progress',
  'pending',
  'paid',
  'failed',
  'abandoned',
  'cancelled',
  'shipped',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** お客様の注文履歴と KPI に出さない状態（設計書 5-5）。メールで知らせた注文だけを見せる。 */
export const HIDDEN_ORDER_STATUSES = ['payment_in_progress', 'abandoned'] as const satisfies readonly OrderStatus[];

/** PostgREST の not.in に渡す形。`.not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)` */
export const HIDDEN_ORDER_STATUS_FILTER = `(${HIDDEN_ORDER_STATUSES.join(',')})`;

export const CANCEL_REASONS = ['stock_unavailable', 'customer_request', 'suspected_fraud', 'other'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  stock_unavailable: '在庫切れ',
  customer_request: 'お客様の依頼',
  suspected_fraud: '不正の疑い',
  other: 'その他',
};

export const PAYMENT_EXCEPTION_REASONS = [
  'order_not_creatable',
  'paid_amount_mismatch',
  'cancelled_order_paid',
  'state_conflict',
  'unexpected_state',
  'stripe_object_missing',
] as const;

export type PaymentExceptionReason = (typeof PAYMENT_EXCEPTION_REASONS)[number];

export const PAYMENT_EXCEPTION_REASON_LABELS: Record<PaymentExceptionReason, string> = {
  order_not_creatable: '注文を作れない支払い',
  paid_amount_mismatch: '支払額の違い',
  cancelled_order_paid: '取り消した注文への入金',
  state_conflict: '注文と支払いの矛盾',
  unexpected_state: '想定外の支払い状態',
  stripe_object_missing: 'Stripe に支払いが無い',
};

/** 受付 RPC が返す理由コード（設計書 4-3） */
export const PLACE_ORDER_REJECTIONS = [
  'draft_not_found',
  'item_unavailable',
  'amount_mismatch',
  'currency_mismatch',
  'zero_amount',
] as const;

export type PlaceOrderRejection = (typeof PLACE_ORDER_REJECTIONS)[number];

/** 入金済みにしたときのメールの書き分け（設計書 5-4）。送信権はどれも paid */
export type PaidEmailVariant = 'order_confirmed' | 'payment_received' | 'payment_received_after_expiry';

/** 管理画面のメモの上限（DB の CHECK と同じ） */
export const ADMIN_NOTE_MAX_LENGTH = 500;

/** 管理画面の「要対応・要確認」欄の1行（要対応）。お客様の個人情報は入れない */
export type AttentionException = {
  id: string;
  reason: PaymentExceptionReason;
  reasonLabel: string;
  detail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  paymentRef: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  detectionCount: number;
  /** 未入金の注文が付いていれば「注文を取り消して解決」を選べる */
  canCancelOrder: boolean;
};

/** 管理画面の「要対応・要確認」欄の1行(要確認) */
export type AttentionReview = {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  reviewReason: string;
  reviewReasonLabel: string;
  reviewMarkedAt: string | null;
};

export type OrderAttention = {
  exceptions: AttentionException[];
  reviews: AttentionReview[];
  counts: { exceptions: number; reviews: number };
};
