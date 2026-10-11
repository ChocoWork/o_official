import type {
  OrderRefundSource,
  OrderRefundStatus,
  RefundErrorCode,
  RefundErrorResponse,
  RefundPaymentMethod,
  StripeRefundReason,
} from '@/lib/orders/refund/refund-types';

/**
 * 返金の窓口の誤りの言葉と HTTP、履歴や画面に出す言葉（グループ E-2 設計書 5-5・9-2）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。画面に出す言葉は、ここの1か所だけで持つ。
 */
export const REFUND_ERROR_MESSAGES = {
  order_not_found: { status: 404, message: '注文が見つかりません。' },
  order_not_refundable: { status: 409, message: 'この注文は返金できません。' },
  order_not_cancellable: { status: 409, message: '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。' },
  awaiting_refund_exists: { status: 409, message: '確かめ中の返金があります。先に確かめてください。' },
  refund_request_mismatch: { status: 409, message: '画面を開き直してから、もう一度返金してください。' },
  refund_line_not_in_order: { status: 409, message: '返金できる数を超えています。画面を開き直してください。' },
  quantity_exceeds_unshipped: { status: 409, message: '返金できる数を超えています。画面を開き直してください。' },
  quantity_exceeds_shipped: { status: 409, message: '返金できる数を超えています。画面を開き直してください。' },
  shipping_exceeds: { status: 409, message: '返せる送料を超えています。' },
  exceeds_refundable: { status: 409, message: '返せる額を超えています。' },
  must_include_unshipped: { status: 409, message: '全額を返金する時は、まだ発送していない商品もすべて選んでください。' },
  must_be_full: { status: 409, message: 'まだ発送していない注文の商品を全部返す時は、送料と返金額も全部返してください。' },
  invalid_argument: { status: 400, message: '入力を確かめてください。' },
} as const satisfies Record<RefundErrorCode, { status: 400 | 404 | 409; message: string }>;

/** 窓口に届いた中身の形が誤っている時（400）。どこが誤りかは返さない */
export const INVALID_REQUEST_MESSAGE = '入力を確かめてください。';
export const INVALID_REQUEST_BODY: RefundErrorResponse = { error: INVALID_REQUEST_MESSAGE, code: 'invalid_request' };

/** 思いがけない失敗（500）の言葉。何をしようとして失敗したかで分ける */
export const REFUND_FAILURE_MESSAGES = {
  create: '返金の記録に失敗しました。',
  cancel: '注文のキャンセルに失敗しました。',
  materials: '返金の材料を読み込めませんでした。',
  settings: 'ショップの設定を読み込めませんでした。',
  settings_update: 'ショップの設定を保存できませんでした。',
} as const;
export type RefundFailureKind = keyof typeof REFUND_FAILURE_MESSAGES;

/** 通信が切れたなど、サーバーが返金を記録したか分からない時（502）に画面が出す言葉。返金とキャンセルの両方で使う */
export const UNKNOWN_REFUND_OUTCOME_MESSAGE =
  '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

export function refundErrorBody(code: RefundErrorCode): RefundErrorResponse {
  return { error: REFUND_ERROR_MESSAGES[code].message, code };
}

export function refundFailureBody(kind: RefundFailureKind): RefundErrorResponse {
  return { error: REFUND_FAILURE_MESSAGES[kind], code: 'failed' };
}

/** Stripe が返金を断った時（422）。理由の言葉があれば括弧で添える */
export function stripeRejectedBody(reasonLabel: string | null): RefundErrorResponse {
  return {
    error: `Stripe が返金を受け付けませんでした${reasonLabel ? `（${reasonLabel}）` : ''}。`,
    code: 'stripe_rejected',
  };
}

/** 答えが分からない時（502）。画面は返金の番号を持ち、同じ二重防止の番号で送り直して確かめる */
export function unknownOutcomeBody(refundId: string): RefundErrorResponse {
  return { error: UNKNOWN_REFUND_OUTCOME_MESSAGE, code: 'unknown_outcome', refundId };
}

export const REFUND_STATUS_LABELS = {
  awaiting_response: '返事待ち',
  error: 'エラー',
  pending: '保留',
  succeeded: '成功',
  failed: '失敗',
} as const satisfies Record<OrderRefundStatus, string>;

/** 履歴の返金の行の「どこから」 */
export const REFUND_SOURCE_LABELS = {
  admin: '管理画面',
  order_cancel: '注文のキャンセル',
  stripe_dashboard: 'Stripe の画面',
  auto_cancelled_order_payment: '自動の返金（取り消した注文への入金）',
  auto_amount_mismatch: '自動の取消（支払額の違い）',
  legacy: '前からの写し',
} as const satisfies Record<OrderRefundSource, string>;

export const STRIPE_REFUND_REASON_LABELS = {
  requested_by_customer: 'お客様の希望',
  duplicate: '重複した支払い',
  fraudulent: '不正の疑い',
} as const satisfies Record<StripeRefundReason, string>;

/**
 * 返金の失敗の理由の言葉（Stripe の失敗の理由と、こちらの理由 not_found_in_stripe・stripe_rejected）。
 * Stripe は表に無い記号も返すので、呼ぶ側は refundFailureReasonLabel(reason) で引く。
 * ?? で引くと、constructor のような名前は Object.prototype の物が返り、表に無い記号が「不明な理由」にならない。
 */
export const REFUND_FAILURE_REASON_LABELS: Readonly<Record<string, string>> = {
  expired_or_canceled_card: 'カードが使えません',
  lost_or_stolen_card: 'カードが使えません',
  declined: 'カード会社に断られました',
  insufficient_funds: 'Stripe の残高が足りません',
  merchant_request: '店が取り消しました',
  expired: '口座の入力の期限が過ぎました',
  charge_for_pending_refund_disputed: '異議申し立てがありました',
  not_found_in_stripe: 'Stripe に届きませんでした',
  stripe_rejected: 'Stripe が受け付けませんでした',
  unknown: '不明な理由',
};

/** 返金の失敗の理由の記号を言葉にする。表に無い記号・空は「不明な理由」（?? で引くと constructor などの名前は Object.prototype の物が返るので、表に自分の欄がある時だけ引く） */
export function refundFailureReasonLabel(reason: string | null | undefined): string {
  return reason && Object.hasOwn(REFUND_FAILURE_REASON_LABELS, reason)
    ? REFUND_FAILURE_REASON_LABELS[reason]
    : REFUND_FAILURE_REASON_LABELS.unknown;
}

const REFUND_TIMING_NOTES = {
  card: 'お金はカード会社によって、5〜10営業日ほどで戻ります。',
  link: 'お金はカード会社によって、5〜10営業日ほどで戻ります。',
  paypay: 'お金は PayPay 残高にすぐ戻ります。',
  konbini: 'コンビニ払いの返金は、お客様に返金先の口座を入れてもらう必要があります（Stripe からお客様にメールが届きます。45日以内）。',
  unknown: 'お金が戻るまでの日数は、お支払いの方法によって異なります。',
} as const satisfies Record<RefundPaymentMethod, string>;

/** 返金の画面に出す、お金が戻る時期の案内（支払い方法ごと） */
export function refundTimingNote(method: RefundPaymentMethod): string {
  return REFUND_TIMING_NOTES[method];
}

/**
 * 金額の書き方（本計画の Global Constraints「金額の書き方」）。ブラウザの画面で使う。
 * メールとサーバーの formatCurrency（src/lib/orders/order-confirmation-email.ts）と同じ出力で、全角の ￥ と桁区切りになる。
 */
export function formatYen(amount: number): string {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(amount);
}
