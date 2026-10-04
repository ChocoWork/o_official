import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import {
  notifyShopOfException,
  reconcileCheckoutPayment,
  type ReconcileResult,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps, listUnsentShopAlerts } from '@/lib/stripe/checkout-payment-reconciler-deps';

// 照合の見回り（グループ A 設計書 2-2）。毎時、決済画面を開いてから30分を超えた支払い手続き中の注文と、
// 入金待ちの全件を Stripe の現在値と照合する。まだ開いている決済はその場で失効させる。
// グループ F の受付 API 適用後は、Webhook が届かなくても放棄された注文の在庫を最長90分で戻す。
// 現在は Stripe が入金済みまたは入金待ちを報告してから注文を作るため、放棄した checkout では在庫を確保しない。
// 入金待ちはアプリ独自の日数で打ち切らず、
// Stripe が期限切れを確定したときだけ失敗にする（FREQ-388 の日数の底上げは不要になった）。
// pg_cron + pg_net から呼ばれる。net.http_post は POST しか送れないため POST。

export const maxDuration = 60;

// 直列の Stripe 呼び出しは1件あたり数百msかかる。maxDuration に収まるよう1回50件まで（レビュー指摘 I3）。
const MAX_ORDERS_PER_RUN = 50;

// ここで打ち切って残りは次回に回す。maxDuration の余裕を持って早めに切る。
const TIME_BUDGET_MS = 45_000;

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/** 決済画面は開いてから30分ちょうどまで有効、30分を超えたら失効（設計書 2-2） */
const CHECKOUT_SESSION_VALIDITY_MS = 30 * 60 * 1000;

const MAX_SHOP_ALERTS_PER_RUN = 20;

type SweepOrderRow = {
  id: string;
  status: 'payment_in_progress' | 'pending';
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type AuthorizationResult =
  | { ok: true }
  | { ok: false; reason: string; misconfigured: boolean };

function checkAuthorization(request: Request): AuthorizationResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true };
  }

  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, reason: 'Missing Authorization header', misconfigured: false };
  }

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      reason: 'Authorization header does not match CRON_SECRET',
      misconfigured: false,
    };
  }

  return { ok: true };
}

// 設定ミス（CRON_SECRET 未設定）の監査ログは、全体で10分に1回までにする（FREQ-370）。
// subject を付けると IP を使わない共通のカウンタになるので、攻撃元を散らしても増えない。
const MISCONFIGURED_AUDIT_THROTTLE = {
  endpoint: 'cron:expire-pending-orders:misconfigured',
  limit: 1,
  windowSeconds: 600,
  subject: 'all-callers',
} as const;

/**
 * 認証に失敗した要求を記録する（FREQ-370）。
 * ヘッダの欠落・不一致はアプリのログにだけ残す（ヘッダの値は出さない）。
 * CRON_SECRET 未設定（運用側の設定ミス）は監査ログにも残す。ただし全体で10分に1回まで。
 */
async function recordUnauthorized(
  request: Request,
  auth: { reason: string; misconfigured: boolean },
): Promise<void> {
  console.warn('[cron] expire-pending-orders unauthorized', auth.reason);

  if (!auth.misconfigured) return;

  const throttled = await enforceRateLimit({ request, ...MISCONFIGURED_AUDIT_THROTTLE });
  if (throttled) return;

  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: 'failure',
    detail: `Unauthorized: ${auth.reason}`,
  });
}

/** 対象が50件を超えるときは、時間ごとに取得範囲を巡回する（残り続ける注文で後続が飢えない） */
function resolveHourlyBatchOffset(totalOrders: number, nowMs: number): number {
  const batchCount = Math.max(1, Math.ceil(totalOrders / MAX_ORDERS_PER_RUN));
  const hour = Math.floor(nowMs / MILLISECONDS_PER_HOUR);
  return (hour % batchCount) * MAX_ORDERS_PER_RUN;
}

export async function POST(request: Request) {
  const auth = checkAuthorization(request);
  if (!auth.ok) {
    await recordUnauthorized(request, auth);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServiceRoleClient();
  const stripe = getStripeServerClient();
  const deps = await createDefaultReconcilerDeps();

  const nowMs = Date.now();
  const staleBefore = new Date(nowMs - CHECKOUT_SESSION_VALIDITY_MS).toISOString();
  const candidateFilter =
    `and(status.eq.payment_in_progress,checkout_session_created_at.lt.${staleBefore}),status.eq.pending`;

  const { count: candidateCountValue, error: countError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .or(candidateFilter);

  if (countError) {
    console.error('[cron] failed to count sweep candidates', countError);
    return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });
  }

  const candidateCount = candidateCountValue ?? 0;
  let batchOffset = resolveHourlyBatchOffset(candidateCount, nowMs);

  const loadBatch = (offset: number) => supabase
    .from('orders')
    .select('id, status, payment_intent_id, checkout_session_id')
    .or(candidateFilter)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + MAX_ORDERS_PER_RUN - 1);

  let { data, error } = await loadBatch(batchOffset);

  // 件数の取得と一覧の間に Webhook が注文を動かし、選んだ範囲が空になることがある。先頭範囲へ1回だけ戻す。
  if (!error && batchOffset > 0 && (data?.length ?? 0) === 0) {
    batchOffset = 0;
    ({ data, error } = await loadBatch(batchOffset));
  }

  if (error) {
    console.error('[cron] failed to list sweep candidates', error);
    return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });
  }

  const orders = (data ?? []) as SweepOrderRow[];
  const actions: Record<string, number> = {};
  let processed = 0;
  let expiredSessions = 0;
  let needsReview = 0;
  let needsAction = 0;
  let failed = 0;
  const failedOrderIds: string[] = [];
  const startedAt = Date.now();
  let timeBudgetExhausted = false;

  const countResult = (result: ReconcileResult) => {
    if (result.kind === 'needs_action') {
      needsAction += 1;
      return;
    }
    if (result.kind === 'needs_review') {
      needsReview += 1;
    }
    actions[result.action.type] = (actions[result.action.type] ?? 0) + 1;
  };

  for (const order of orders) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timeBudgetExhausted = true;
      break;
    }

    processed += 1;

    try {
      if (order.status === 'payment_in_progress' && order.checkout_session_id) {
        if ((await expireOpenCheckoutSession(stripe, order.checkout_session_id)) === 'expired') {
          expiredSessions += 1;
        }
      }

      countResult(await reconcileCheckoutPayment(deps, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      }));
    } catch (orderError) {
      // 1件の失敗で残りを止めない。状態を確定できない注文は変更せず、次回と監査ログで再確認する。
      console.error('[cron] failed to reconcile order', order.id, orderError);
      failed += 1;
      failedOrderIds.push(order.id);
    }
  }

  let shopAlertsSent = 0;
  if (!timeBudgetExhausted) {
    try {
      for (const { exceptionId, alert } of await listUnsentShopAlerts(supabase, MAX_SHOP_ALERTS_PER_RUN)) {
        if (await notifyShopOfException(deps, exceptionId, alert)) {
          shopAlertsSent += 1;
        }
      }
    } catch (alertError) {
      console.error('[cron] failed to resend shop alerts', alertError);
      failed += 1;
    }
  }

  const summary = {
    processed,
    candidateCount,
    batchOffset,
    expiredSessions,
    actions,
    needsReview,
    needsAction,
    failed,
    shopAlertsSent,
    capped: candidateCount > MAX_ORDERS_PER_RUN,
    timeBudgetExhausted,
  };

  // 時間切れで途中終了した場合でも、この監査行だけは必ず残す（レビュー指摘 I3）。
  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: failed > 0
      ? 'error'
      : needsAction > 0 || timeBudgetExhausted
        ? 'failure'
        : 'success',
    detail: 'Checkout payment reconciliation sweep',
    metadata: { ...summary, failed_order_ids: failedOrderIds.slice(0, 20) },
  });

  return NextResponse.json(summary);
}
