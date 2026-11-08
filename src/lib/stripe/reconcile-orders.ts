import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import { listPendingRefundPaymentIntents } from '@/lib/orders/refund/refund-store';
import { OrderNotFoundForPaymentIntentError, RefundSyncNotConvergedError, syncPaymentIntentRefunds } from './order-refund-sync';
import { ReconcileTransientError } from './checkout-payment-reader';
import { webhookFailureCause, type WebhookFailureCause } from './webhook-events';

type OrderState = { payment_intent_id: string };
type ReconcileDatabase = {
  from(table: 'orders'): {
    select(columns: string): Promise<{ data: OrderState[] | null; error: { message?: string } | null }>;
  };
};
type PaymentIntentSnapshot = { id: string; status: string; amount: number; currency: string; created: number };
/** 注文の無い支払いが全額返金済みかを決めるのに要る分だけ */
type RefundSnapshot = { status: string | null; amount: number };
type ReconcileStripe = {
  paymentIntents: { list(params: { limit: number }): AsyncIterable<PaymentIntentSnapshot> | Iterable<PaymentIntentSnapshot> };
  refunds: { list(params: { payment_intent: string; limit: number }): AsyncIterable<RefundSnapshot> | Iterable<RefundSnapshot> };
};

/** 照合の1件ずつの失敗。原因の記号だけを残す（設計書 2026-10-05 グループ B の 3-3・4-5） */
export type StripeReconciliationError = { sourceId: string; reason: WebhookFailureCause };

/** 注文の無い成功の支払いのうち、直近7日に作られたもの。毎晩の店への知らせに載せる（設計書 2026-10-05 グループ B の 6） */
export type UnmatchedRecentPayment = { id: string; amount: number; currency: string; created: number };

/** 注文の無い支払いを「直近」と数える期間 */
const RECENT_PAYMENT_SECONDS = 7 * 24 * 60 * 60;

export type StripeOrderReconciliationReport = {
  checkedPayments: number;
  unmatchedActivePayments: string[];
  unmatchedRecentPayments: UnmatchedRecentPayment[];
  syncedBalanceTransactions: number;
  errors: StripeReconciliationError[];
};

function failureOf(sourceId: string, error: unknown): StripeReconciliationError {
  return { sourceId, reason: webhookFailureCause(error) };
}

/** 成功した返金の額の合計。ページを全部たどる */
async function succeededRefundTotal(stripe: ReconcileStripe, paymentIntentId: string): Promise<number> {
  let total = 0;
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    if (refund.status === 'succeeded') total += Math.max(0, refund.amount);
  }
  return total;
}

export async function reconcileStripeOrders({
  database,
  stripe,
  syncAccounting,
  now = () => new Date(),
}: {
  database: ReconcileDatabase;
  stripe: ReconcileStripe;
  syncAccounting?: (paymentIntentId: string) => Promise<unknown>;
  now?: () => Date;
}): Promise<StripeOrderReconciliationReport> {
  const { data: orders, error } = await database.from('orders').select('payment_intent_id');
  if (error) throw new ReconcileTransientError('db_unavailable');
  const paymentIntentIdsWithOrder = new Set((orders ?? []).map((order) => order.payment_intent_id));
  const recentSince = Math.floor(now().getTime() / 1000) - RECENT_PAYMENT_SECONDS;
  const report: StripeOrderReconciliationReport = {
    checkedPayments: 0,
    unmatchedActivePayments: [],
    unmatchedRecentPayments: [],
    syncedBalanceTransactions: 0,
    errors: [],
  };

  for await (const payment of stripe.paymentIntents.list({ limit: 100 })) {
    if (payment.status !== 'succeeded') continue;
    report.checkedPayments += 1;

    // 注文の無い支払いだけ、返金し切っているかを読む。注文のある支払いの返金は、返金の照合（reconcileRecentRefunds）が合わせる。
    // 支払いごとに失敗を受け止め、その回の残りを止めない（設計書 4-5）
    if (!paymentIntentIdsWithOrder.has(payment.id)) {
      try {
        if ((await succeededRefundTotal(stripe, payment.id)) < payment.amount) {
          report.unmatchedActivePayments.push(payment.id);
          if (payment.created >= recentSince) {
            report.unmatchedRecentPayments.push({
              id: payment.id,
              amount: payment.amount,
              currency: payment.currency,
              created: payment.created,
            });
          }
        }
      } catch (refundError) {
        report.errors.push(failureOf(payment.id, refundError));
      }
      continue;
    }

    if (!syncAccounting) continue;
    try {
      await syncAccounting(payment.id);
      report.syncedBalanceTransactions += 1;
    } catch (accountingError) {
      report.errors.push(failureOf(payment.id, accountingError));
    }
  }
  return report;
}

/** 毎晩の返金の照合の結果。errors[].message は原因の記号（収まらない失敗は 'not_converged'、ほかは webhookFailureCause の記号。例外の文は入れない。個人情報が混ざりうるため） */
export type RecentRefundReconciliationReport = {
  checkedPaymentIntents: number;
  syncedRefunds: number;
  errors: Array<{ paymentIntentId: string; message: string }>;
};

/** こちらの保留の返金の支払いを読む件数の上限（DB の関数 list_pending_refund_payment_intents の上限） */
const PENDING_REFUND_PAYMENT_INTENT_LIMIT = 500;

function paymentIntentIdOf(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

/**
 * 毎晩の返金の照合（グループ E-2 設計書 6-2）。こちらの保留の返金の支払いを先に、前の48時間に Stripe で作られた返金の支払いを後に
 * 集め（重複なし）、1つずつ取り込み（order-refund-sync.ts）に通す。知らせの取りこぼしと、保留から成功・失敗に変わる返金を拾う。
 * 注文の無い支払いは数えるだけ、1つの失敗で全体を止めない。deadline（ミリ秒）に届いたら、残りを次の夜に回す。
 * 後回しになるのは、次の夜も範囲が重なる48時間の側にする（保留の側は、この照合でしか拾わない）。
 */
export async function reconcileRecentRefunds(
  deps: RefundServiceDeps,
  options: { since: Date; deadline: number },
): Promise<RecentRefundReconciliationReport> {
  const paymentIntentIds = new Set<string>(
    await listPendingRefundPaymentIntents(deps.store, PENDING_REFUND_PAYMENT_INTENT_LIMIT),
  );
  for await (const refund of deps.stripe.refunds.list({
    created: { gte: Math.floor(options.since.getTime() / 1000) },
    limit: 100,
  })) {
    const paymentIntentId = paymentIntentIdOf(refund.payment_intent);
    if (paymentIntentId) paymentIntentIds.add(paymentIntentId);
  }

  const report: RecentRefundReconciliationReport = { checkedPaymentIntents: 0, syncedRefunds: 0, errors: [] };
  for (const paymentIntentId of paymentIntentIds) {
    if (deps.now().getTime() >= options.deadline) {
      console.warn('[refund-reconcile] stopped at the deadline; the rest waits for the next run');
      break;
    }

    report.checkedPaymentIntents += 1;
    try {
      const synced = await syncPaymentIntentRefunds(deps, paymentIntentId);
      if (synced.kind === 'synced') report.syncedRefunds += synced.results.length;
    } catch (error) {
      // 注文の無い支払い（注文を作れなかった支払い）は、知らせの受け口が要対応にしている。ここでは数えるだけ
      if (error instanceof OrderNotFoundForPaymentIntentError) continue;
      report.errors.push({
        paymentIntentId,
        // 読み直せば収まる失敗。決済の照合（toReconcileError）と同じ記号にする
        message: error instanceof RefundSyncNotConvergedError ? 'not_converged' : webhookFailureCause(error),
      });
    }
  }
  return report;
}

type PayoutSnapshot = { id: string };
type ReconcilePayoutStripe = {
  payouts: { list(params?: { limit: number }): AsyncIterable<PayoutSnapshot> | Iterable<PayoutSnapshot> };
};

export type StripePayoutReconciliationReport = {
  syncedPayouts: number;
  payoutMismatches: number;
  errors: StripeReconciliationError[];
};

export async function reconcileStripePayouts({
  stripe,
  syncPayout,
}: {
  stripe: ReconcilePayoutStripe;
  syncPayout: (payoutId: string) => Promise<{ reconciliationStatus: string }>;
}): Promise<StripePayoutReconciliationReport> {
  const report: StripePayoutReconciliationReport = {
    syncedPayouts: 0,
    payoutMismatches: 0,
    errors: [],
  };

  for await (const payout of stripe.payouts.list({ limit: 100 })) {
    try {
      const result = await syncPayout(payout.id);
      report.syncedPayouts += 1;
      if (result.reconciliationStatus === 'mismatch') report.payoutMismatches += 1;
    } catch (error) {
      report.errors.push(failureOf(payout.id, error));
    }
  }
  return report;
}

type DisputeSnapshot = { id: string };
type ReconcileDisputeStripe = {
  disputes: {
    list(params: { limit: number; created: { gte: number } }): AsyncIterable<DisputeSnapshot> | Iterable<DisputeSnapshot>;
  };
};

export type StripeDisputeReconciliationReport = {
  syncedDisputes: number;
  /** 表の未決着が上限（MAX_OPEN_DISPUTES）を超えていて、古い順の上限までしか取り直していない */
  openDisputesCapped: boolean;
  errors: StripeReconciliationError[];
};

/** 毎晩取り直す未決着の dispute の上限（実際はごく少数。暴走した時に毎晩の実行を止めないための枠。作成の古い順） */
const MAX_OPEN_DISPUTES = 500;

/** 新しい dispute を拾う範囲（作成から30日。Stripe が出来事を残す期間と同じ） */
const DISPUTE_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;

/** 一覧から拾う dispute の上限（100件ずつ最大5ページ） */
const MAX_LISTED_DISPUTES = 500;

/**
 * 毎晩の、カード会社からの支払いの取り消しの取りこぼし拾い（FREQ-567-AC-04）。
 * ① 表の中で決着していない dispute は、作成から30日を過ぎた物も取り直す（判断は2か月以上かかる）。作成の古い順に500件まで
 *    （超えたら openDisputesCapped を立てる）。
 * ② 作成から30日以内の新しい dispute を Stripe の一覧から最大500件拾う。
 * 各 dispute を取り込み（dispute-sync.ts）に通す。1件の失敗で全体を止めず、番号と原因の記号だけを残す。
 * 表か一覧を読めなければそのまま投げる（窓口が受け止めて、失敗として errors に残す）。
 */
export async function reconcileStripeDisputes({
  stripe,
  listOpenDisputeIds,
  syncDispute,
  now = () => new Date(),
}: {
  stripe: ReconcileDisputeStripe;
  listOpenDisputeIds: (limit: number) => Promise<string[]>;
  syncDispute: (disputeId: string) => Promise<unknown>;
  now?: () => Date;
}): Promise<StripeDisputeReconciliationReport> {
  // 上限より1件多く読み、超えたかどうかを知る
  const open = await listOpenDisputeIds(MAX_OPEN_DISPUTES + 1);
  const openDisputesCapped = open.length > MAX_OPEN_DISPUTES;
  if (openDisputesCapped) console.warn('[dispute-reconcile] open disputes exceed the limit; only the oldest are re-read');
  const disputeIds = new Set<string>(open.slice(0, MAX_OPEN_DISPUTES));
  let listed = 0;
  for await (const dispute of stripe.disputes.list({
    limit: 100,
    created: { gte: Math.floor(now().getTime() / 1000) - DISPUTE_LOOKBACK_SECONDS },
  })) {
    disputeIds.add(dispute.id);
    listed += 1;
    if (listed >= MAX_LISTED_DISPUTES) break;
  }

  const report: StripeDisputeReconciliationReport = { syncedDisputes: 0, openDisputesCapped, errors: [] };
  for (const disputeId of disputeIds) {
    try {
      await syncDispute(disputeId);
      report.syncedDisputes += 1;
    } catch (error) {
      report.errors.push(failureOf(disputeId, error));
    }
  }
  return report;
}

export type { ReconcileDatabase, ReconcileDisputeStripe, ReconcileStripe, ReconcilePayoutStripe };
