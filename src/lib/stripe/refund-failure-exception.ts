import { notifyShopOfException, type ReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler';

/** Stripe の返金が、うまくいかないまま終わった状態（返金の status） */
export type FailedRefundStatus = 'failed' | 'canceled';

/** DB の CHECK（英小文字・数字・_ の64文字まで）に収まる固定のコード。ID やお客様の情報は入れない */
const DETAIL_BY_STATUS = {
  failed: 'refund_failed_without_order',
  canceled: 'refund_canceled_without_order',
} as const satisfies Record<FailedRefundStatus, string>;

/**
 * 注文が無い支払いの返金が失敗・取消になったことを、要対応として記録し、店へ1回知らせる（既存の要対応の仕組み）。
 *
 * 注文を作れず要対応になった支払い（order_not_creatable）を店が Stripe で返金したあと、その返金が失敗・取消になると、
 * 支払いだけが残る。注文が無いので、支払いのイベントも見回りも、この支払いを二度と見ない。黙って飛ばさずに知らせる。
 *
 * - 理由は既存の unexpected_state。同じ支払い・同じ理由は1行なので、要対応の参照は返金の ID にする
 *   （同じ返金のイベントが何度届いても、行も通知も増えない。別の返金の失敗は別の行として知らせる）。支払いの ID も残す
 * - 解決済みの行は知らせ直さない。メールが送れなければ送信権を戻し、毎時の見回りが送り直す
 * - 記録できなかったとき（一時的な失敗を含む）は握りつぶさず投げる。呼び出し元（worker）がイベントを失敗にして再試行する
 */
export async function raiseRefundFailureWithoutOrder(
  deps: Pick<ReconcilerDeps, 'database' | 'mailer' | 'now'>,
  input: { paymentIntentId: string; refundId: string; refundStatus: FailedRefundStatus },
): Promise<{ exceptionId: string; isNew: boolean }> {
  const detail = DETAIL_BY_STATUS[input.refundStatus];

  const recorded = await deps.database.recordException({
    paymentRef: input.refundId,
    reason: 'unexpected_state',
    detail,
    checkoutSessionId: null,
    paymentIntentId: input.paymentIntentId,
    draftId: null,
    orderId: null,
  });

  if (!recorded.isResolved) {
    await notifyShopOfException(deps, recorded.exceptionId, {
      reason: 'unexpected_state',
      detail,
      orderId: null,
      paymentRef: input.refundId,
      detectedAt: deps.now(),
    });
  }

  return { exceptionId: recorded.exceptionId, isNew: recorded.isNew };
}
