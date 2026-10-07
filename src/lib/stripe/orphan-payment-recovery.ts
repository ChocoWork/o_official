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
 * （同じ頃に Webhook が作った注文には付けない）。同じ Session を何度渡しても、照合関数は同じ結果に収まる（グループ A）。
 * 読む範囲は毎回24時間で重なるので、注文を作る前の失敗は次の回で拾い直せる。
 * 注文の行を作った後の失敗は拾い直せない（その Session には注文が在るので、次の回は飛ばす）。
 * 印を付ける処理は3回まで試し、それでも付けられない注文は、印なし（reviewReason が null）のまま結果に載せて、その回のメールに書く。
 * 照合関数が注文を作った後に投げた場合の残りは、最終レビューで扱う。
 */
export const ORPHAN_LOOKBACK_SECONDS = 24 * 60 * 60;

/** 注文の有無を1回の問い合わせで確かめる Session の数。ID は URL に載るので、長さのため50件ずつにする（本番の ID 66文字×100件は約7KB で、8KB の上限に近い） */
export const ORDER_LOOKUP_BATCH_SIZE = 50;

/** 要確認の印を付ける処理を試す回数。印を付ける DB の関数は、印がまだ無いときだけ付けるので、何度呼んでもよい */
export const MARK_RECOVERED_ATTEMPTS = 3;

/** reviewReason が null は、注文は作ったが要確認の印を付けられなかったこと（店へのメールには載せる） */
export type RecoveredOrder = { orderId: string; reviewReason: RecoveredReviewReason | null };

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

  /** 要確認の印を付ける。MARK_RECOVERED_ATTEMPTS 回とも失敗しても注文は作ってあるので、印なし（null）で返す */
  const markWithRetries = async (orderId: string): Promise<RecoveredReviewReason | null> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MARK_RECOVERED_ATTEMPTS; attempt += 1) {
      try {
        return await deps.markRecovered(orderId);
      } catch (error) {
        lastError = error;
      }
    }
    result.failed += 1;
    console.error('[orphan-recovery] Failed to mark a recovered order', orderId, webhookFailureCause(lastError));
    return null;
  };

  /** 時間切れなら false */
  const recoverBatch = async (sessionIds: string[]): Promise<boolean> => {
    const withOrders = await deps.findSessionIdsWithOrders(sessionIds);
    for (const sessionId of sessionIds) {
      if (withOrders.has(sessionId)) continue;
      if (deps.now() >= deps.deadline) return false;

      let orderId: string | null;
      try {
        orderId = placedOrderId(await deps.reconcile(sessionId));
      } catch (error) {
        // 1件の失敗で残りを止めない。注文を作る前の失敗は、次の回も同じ Session を読む（24時間で重なる）ので拾い直せる。
        // 注文の行を作った後の失敗は、その Session に注文が在るので次の回は飛ばす（拾い直せない）。この残りは最終レビューで扱う
        result.failed += 1;
        console.error('[orphan-recovery] Failed to recover a payment', sessionId, webhookFailureCause(error));
        continue;
      }
      if (orderId) result.recovered.push({ orderId, reviewReason: await markWithRetries(orderId) });
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

/** 店へのメールに載せる金額を読む。読めなくてもメールは送る（金額は「金額不明」になる。読めなかったことは1行だけ記録する）。 */
export async function loadRecoveredOrderSummaries(
  db: OrdersQueryClient,
  recovered: RecoveredOrder[],
): Promise<RecoveredOrderSummary[]> {
  if (recovered.length === 0) return [];
  const { data, error } = await db
    .from('orders')
    .select('id, total_amount, currency')
    .in('id', recovered.map((order) => order.orderId));
  if (error) console.error('[orphan-recovery] Failed to read recovered order amounts', 'db_unavailable');
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
