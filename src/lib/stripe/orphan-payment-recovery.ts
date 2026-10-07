import {
  reconcileCheckoutPayment,
  type ReconcileResult,
  type ReconcilerDeps,
} from '@/lib/stripe/checkout-payment-reconciler';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
import { markOrderRecoveredFromPayment, type OpsStore, type RecoveredReviewReason } from '@/lib/ops/ops-store';
import type { RecoveredOrderSummary } from '@/lib/ops/ops-alert-mail';

/**
 * 注文の無い支払いの拾い上げ（設計書 2026-10-05 グループ B の 3-5・3-6）。毎時の見回りの最後に動く。
 * 直近24時間に作られた完了済みの Checkout Session のうち、注文の無いものを照合関数に渡す。
 * 照合関数がその呼び出しで注文を作ったときだけ、要確認「支払いから作った注文」を付ける
 * （同じ頃に Webhook が作った注文には付けない）。読む範囲は毎回24時間で重なるので、
 * 1回失敗しても次の回で拾える。同じ Session を何度渡しても、照合関数は同じ結果に収まる（グループ A）。
 */
export const ORPHAN_LOOKBACK_SECONDS = 24 * 60 * 60;

/** 注文の有無を1回の問い合わせで確かめる Session の数 */
export const ORDER_LOOKUP_BATCH_SIZE = 100;

export type RecoveredOrder = { orderId: string; reviewReason: RecoveredReviewReason };

export type OrphanRecoveryDeps = {
  listCompletedSessionIds(createdGteSeconds: number): AsyncIterable<string>;
  findSessionIdsWithOrders(sessionIds: string[]): Promise<Set<string>>;
  reconcile(checkoutSessionId: string): Promise<ReconcileResult>;
  markRecovered(orderId: string): Promise<RecoveredReviewReason>;
  now(): number;
  /** この時刻（ミリ秒）を過ぎたら新しく照合しない */
  deadline: number;
};

export type OrphanRecoveryResult = {
  checkedSessions: number;
  recovered: RecoveredOrder[];
  failed: number;
  timeBudgetExhausted: boolean;
};

const PLACE_ACTIONS: ReadonlySet<string> = new Set(['place_and_mark_paid', 'place_and_mark_awaiting']);

/** 照合関数がこの呼び出しで注文を作ったなら、その注文の ID */
export function placedOrderId(result: ReconcileResult): string | null {
  if (result.kind === 'needs_action' || !PLACE_ACTIONS.has(result.action.type)) return null;
  return result.orderId;
}

export async function recoverOrphanPayments(deps: OrphanRecoveryDeps): Promise<OrphanRecoveryResult> {
  const result: OrphanRecoveryResult = { checkedSessions: 0, recovered: [], failed: 0, timeBudgetExhausted: false };
  const createdGte = Math.floor(deps.now() / 1000) - ORPHAN_LOOKBACK_SECONDS;

  /** 時間切れなら false */
  const recoverBatch = async (sessionIds: string[]): Promise<boolean> => {
    const withOrders = await deps.findSessionIdsWithOrders(sessionIds);
    for (const sessionId of sessionIds) {
      if (withOrders.has(sessionId)) continue;
      if (deps.now() >= deps.deadline) return false;
      try {
        const orderId = placedOrderId(await deps.reconcile(sessionId));
        if (orderId) result.recovered.push({ orderId, reviewReason: await deps.markRecovered(orderId) });
      } catch (error) {
        // 1件の失敗で残りを止めない。次の回も同じ Session を読むので、そこで拾い直す
        result.failed += 1;
        console.error('[orphan-recovery] Failed to recover a payment', sessionId, webhookFailureCause(error));
      }
    }
    return true;
  };

  let batch: string[] = [];
  for await (const sessionId of deps.listCompletedSessionIds(createdGte)) {
    if (deps.now() >= deps.deadline) {
      result.timeBudgetExhausted = true;
      return result;
    }
    result.checkedSessions += 1;
    batch.push(sessionId);
    if (batch.length < ORDER_LOOKUP_BATCH_SIZE) continue;
    if (!(await recoverBatch(batch))) {
      result.timeBudgetExhausted = true;
      return result;
    }
    batch = [];
  }
  if (batch.length > 0 && !(await recoverBatch(batch))) result.timeBudgetExhausted = true;
  return result;
}

/** 注文の表の、拾い上げに要る読み方だけ */
export type OrdersQueryClient = {
  from(table: 'orders'): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

/** Stripe の Checkout Session の一覧の、拾い上げに要る読み方だけ */
export type CheckoutSessionLister = {
  checkout: {
    sessions: {
      list(params: { created: { gte: number }; status: 'complete'; limit: number }): AsyncIterable<{ id: string }>;
    };
  };
};

async function* completedSessionIds(stripe: CheckoutSessionLister, createdGteSeconds: number): AsyncIterable<string> {
  const list = stripe.checkout.sessions.list({ created: { gte: createdGteSeconds }, status: 'complete', limit: 100 });
  for await (const session of list) yield session.id;
}

export function createOrphanRecoveryDeps(options: {
  db: OrdersQueryClient;
  opsStore: OpsStore;
  stripe: CheckoutSessionLister;
  reconcilerDeps: ReconcilerDeps;
  deadline: number;
}): OrphanRecoveryDeps {
  return {
    listCompletedSessionIds: (createdGteSeconds) => completedSessionIds(options.stripe, createdGteSeconds),
    findSessionIdsWithOrders: async (sessionIds) => {
      const { data, error } = await options.db
        .from('orders')
        .select('checkout_session_id')
        .in('checkout_session_id', sessionIds);
      if (error) throw new ReconcileTransientError('db_unavailable');
      return new Set((data ?? []).map((row) => String(row.checkout_session_id)));
    },
    reconcile: (checkoutSessionId) => reconcileCheckoutPayment(options.reconcilerDeps, { checkoutSessionId }),
    markRecovered: (orderId) => markOrderRecoveredFromPayment(options.opsStore, orderId),
    now: () => Date.now(),
    deadline: options.deadline,
  };
}

/** 店へのメールに載せる金額を読む。読めなくてもメールは送る（金額は「金額不明」になる）。 */
export async function loadRecoveredOrderSummaries(
  db: OrdersQueryClient,
  recovered: RecoveredOrder[],
): Promise<RecoveredOrderSummary[]> {
  if (recovered.length === 0) return [];
  const { data, error } = await db
    .from('orders')
    .select('id, total_amount, currency')
    .in('id', recovered.map((order) => order.orderId));
  const rows = new Map((error ? [] : data ?? []).map((row) => [String(row.id), row]));
  return recovered.map(({ orderId, reviewReason }) => {
    const row = rows.get(orderId);
    return {
      orderId,
      reviewReason,
      totalAmount: typeof row?.total_amount === 'number' ? row.total_amount : null,
      currency: typeof row?.currency === 'string' ? row.currency : null,
    };
  });
}
