import type { ShopPaymentAlert } from '@/lib/orders/order-lifecycle-emails';
import { refundFailureReasonLabel } from '@/lib/orders/refund/refund-messages';
import { applyRefundSideEffects, type RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import {
  listAwaitingOrderRefunds,
  markOrderRefundError,
  recordOrderRefundResult,
} from '@/lib/orders/refund/refund-store';
import {
  listPaymentIntentRefunds,
  readPaymentMethodType,
  type StripeRefundSnapshot,
} from '@/lib/orders/refund/refund-stripe';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';

/**
 * 返事待ちの返金の見回り（グループ E-2 設計書 6-2）。毎時の見回りの最後に動く。
 * 返金は、記録（返事待ち）を先に作ってから Stripe に頼む。頼んだ後に返事を書けなかった記録（通信が切れた・アプリが落ちた）は
 * 返事待ちのまま残るので、その支払いの返金の一覧から印 refund_id で探す。見つかれば結果を書き、
 * 見つからなければ（Stripe に届かなかった）エラーにして、要対応「返金の失敗」を作り、店へ知らせる。
 * 頼んだばかりの記録は、まだ頼んでいる最中かもしれない。呼ぶ側が olderThan（15分前）で切る。
 */
export type AwaitingRefundSweepReport = {
  checked: number;
  synced: number;
  errored: number;
  failures: number;
  timeBudgetExhausted: boolean;
};

type AwaitingRefund = { refundId: string; orderId: string; paymentIntentId: string | null; createdAt: string };
type SettleOutcome = 'synced' | 'errored' | 'unchanged';

/** Stripe に見つからなかった記録のエラーの理由（返金の記録の stripe_failure_reason） */
const NOT_FOUND_REASON = 'not_found_in_stripe';

/** 要対応「返金の失敗」の店への知らせ。Stripe の返金の番号がまだ無いので、要対応の参照は返金の記録の番号 */
function notFoundAlert(deps: RefundServiceDeps, record: AwaitingRefund): ShopPaymentAlert {
  return {
    reason: 'refund_failed',
    detail: NOT_FOUND_REASON,
    orderId: record.orderId,
    paymentRef: record.refundId,
    detectedAt: deps.now(),
    refundFailure: {
      failureReasonLabel: refundFailureReasonLabel(NOT_FOUND_REASON),
      // 返事待ちの間は在庫を動かしていないので、確保し直せなかった商品は無い
      shortages: [],
      // キャンセルのお知らせは、Stripe が受け付けた時に書く。受け付けていないので、まだ送っていない
      cancelEmailSent: false,
    },
  };
}

/** Stripe がその支払いを知らない（何度読んでも見つからない）。見つからなかった返金と同じにエラーにする */
function isUnknownToStripe(error: unknown): boolean {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as { type?: unknown; code?: unknown };
  return failure.type === 'StripeInvalidRequestError' && failure.code === 'resource_missing';
}

/** その支払いの返金の一覧から、印 refund_id が記録の番号に当たる返金を探す。支払いそのものを Stripe が知らなければ、見つからなかったのと同じ（null） */
async function findInStripe(
  deps: RefundServiceDeps,
  paymentIntentId: string,
  refundId: string,
): Promise<StripeRefundSnapshot | null> {
  try {
    const refunds = await listPaymentIntentRefunds(deps.stripe, paymentIntentId);
    return refunds.find((refund) => refund.metadataRefundId === refundId) ?? null;
  } catch (error) {
    if (isUnknownToStripe(error)) return null;
    throw error;
  }
}

async function settleOne(deps: RefundServiceDeps, record: AwaitingRefund): Promise<SettleOutcome> {
  if (record.paymentIntentId) {
    const found = await findInStripe(deps, record.paymentIntentId, record.refundId);
    if (found) {
      // 頼んだ時の返事を書けなかったので、記録には支払いの種類がまだ無い。一覧の写しの種類は null なので、Stripe から読んで渡す
      const paymentMethodType = found.paymentMethodType ?? (await readPaymentMethodType(deps.stripe, record.paymentIntentId));
      const result = await recordOrderRefundResult(deps.store, record.refundId, { ...found, paymentMethodType });
      // 後の始末は例外を投げない（記録はもう書けているので、落ちても結果を変えない。Task 5 の決め事）
      await applyRefundSideEffects(deps, result);
      return 'synced';
    }
  }

  // Stripe に届かなかった（支払いの番号が無い注文の記録も、Stripe に頼めなかったのでここ）。エラーにして要対応を作る
  const marked = await markOrderRefundError(deps.store, record.refundId, NOT_FOUND_REASON, true);
  if (marked.outcome !== 'errored') {
    // 見回りの間に、知らせか確かめ直しが先に片付けた
    return 'unchanged';
  }
  if (marked.exceptionId) {
    try {
      await deps.notifyShopOfRefundFailure(marked.exceptionId, notFoundAlert(deps, record));
    } catch (error) {
      // エラーにした記録は書けている。知らせが送れなくても、店への知らせは毎時の見回りが未送信の要対応として送り直す
      console.error('[refund-sweep] failed to notify the shop', webhookFailureCause(error));
    }
  }
  return 'errored';
}

export async function sweepAwaitingRefunds(
  deps: RefundServiceDeps,
  options: { olderThan: Date; limit: number; deadline: number },
): Promise<AwaitingRefundSweepReport> {
  const report: AwaitingRefundSweepReport = { checked: 0, synced: 0, errored: 0, failures: 0, timeBudgetExhausted: false };

  for (const record of await listAwaitingOrderRefunds(deps.store, options.olderThan, options.limit)) {
    if (deps.now().getTime() >= options.deadline) {
      report.timeBudgetExhausted = true;
      break;
    }

    report.checked += 1;
    try {
      const outcome = await settleOne(deps, record);
      if (outcome === 'synced') report.synced += 1;
      if (outcome === 'errored') report.errored += 1;
    } catch (error) {
      // 1件の失敗で残りを止めない。記録は返事待ちのまま残り、次の回に確かめ直す
      report.failures += 1;
      console.error('[refund-sweep] failed to settle an awaiting refund', record.refundId, webhookFailureCause(error));
    }
  }

  return report;
}
