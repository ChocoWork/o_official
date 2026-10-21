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
  'refund_failed',
] as const;

export type PaymentExceptionReason = (typeof PAYMENT_EXCEPTION_REASONS)[number];

export const PAYMENT_EXCEPTION_REASON_LABELS: Record<PaymentExceptionReason, string> = {
  order_not_creatable: '注文を作れない支払い',
  paid_amount_mismatch: '支払額の違い',
  cancelled_order_paid: '取り消した注文への入金',
  state_conflict: '注文と支払いの矛盾',
  unexpected_state: '想定外の支払い状態',
  stripe_object_missing: 'Stripe に支払いが無い',
  refund_failed: '返金の失敗',
};

/**
 * 受付 RPC が返す理由コード（グループ A 設計書 4-3）。
 * cart_changed・price_changed・stock_changed は受け付けの窓口から呼んだときだけ返る（グループ F 設計書 6-2）。
 * login_changed は受け付けの窓口から呼んだときだけ返る（グループ C 設計書 5-3）。
 */
export const PLACE_ORDER_REJECTIONS = [
  'draft_not_found',
  'item_unavailable',
  'amount_mismatch',
  'currency_mismatch',
  'zero_amount',
  'price_changed',
  'stock_changed',
  'cart_changed',
  'login_changed',
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
  /** 返金の失敗で、注文の返せる額が残っていれば「もう一度返金する」を選べる */
  canRetryRefund: boolean;
  /**
   * 理由が返金の失敗の時だけ。返金の記録の額・失敗の理由の言葉・確保し直せなかった商品と数（記録が見つからない時は額0・商品なし）。
   * returnId は、返品の返金（受け取りで今返金・額を決めて返金）の失敗ならその返品の番号。画面は、番号があれば「もう一度返金する」で
   * 注文の返品の画面を開く（ふつうの返金の画面では、返金待ちの品を選べないため。グループ E-3、本計画 P21）。ふつうの返金・記録が
   * 見つからない時は null。省ける形なのは、今の見本を書き換えずに済ませるため。窓口は必ず返す。ほかの理由は refundFailure ごと null
   */
  refundFailure: {
    amount: number;
    failureReasonLabel: string;
    shortages: Array<{ name: string; quantity: number }>;
    returnId?: string | null;
  } | null;
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
  deliveries?: import('@/lib/orders/tracking/delivery-types').DeliveryAttentionItem[];
  counts: { exceptions: number; reviews: number; deliveries?: number };
};
