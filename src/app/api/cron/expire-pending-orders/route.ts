import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  expireCheckoutSessionForPaymentIntent,
  isPendingCheckoutPaymentIntentStatus,
} from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';
import { sendOrderConfirmationEmailForOrderId } from '@/lib/orders/order-confirmation-email';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

// 古い pending 注文を Stripe の確定状態と突き合わせる（FREQ-356）。
// open の Checkout Session は失効させ、Stripe 側で支払不能と確認できた注文だけ
// 在庫を戻す。complete の非同期決済は将来入金され得るため、アプリ独自の期限では
// 取り消さず監査対象として残す。
// pg_cron + pg_net から呼ばれる。net.http_post は POST しか送れないため POST。

export const maxDuration = 60;

// この値は src/app/api/checkout/create-session/route.ts の
// payment_method_options.*.expires_after_days の最大値（現状 konbini = 3日）より
// 必ず大きくすること。逆転すると、まだ支払い可能なコンビニ払込票をこのジョブが
// 失効させてしまう（顧客はレジで支払いを拒否される）。
const DEFAULT_EXPIRY_DAYS = 5;

// コンビニ払込票より必ず後に再照合するための下限。環境変数がこれを下回る値を要求しても、
// まだ支払える払込票を失効させないためここで底上げする（FREQ-388、旧レビュー指摘 I7）。
//
// Stripe: 「保留中のコンビニ決済は、指定された日付の深夜直前 (23:59:59) に有効期限が切れます」。
// expires_after_days=3 で確定が 0:00 なら、払込票は約4日（3日23時間59分）有効になる。
// さらに「期限が切れる前に有効な払込取扱票を発行した場合には、expires_at の後でもレジで
// 決済を『完了』できます」とあり、期限ぴったりで打ち切ると支払い中の客とぶつかる。
// 日本時間と UTC の9時間差も踏まえ、1日以上の余裕を取って5日にする。
const MIN_EXPIRY_DAYS = 5;

// 直列の Stripe 呼び出し（PaymentIntent/Session の取得と必要時の expire）は1件あたり
// 数百msかかるため、200件では
// maxDuration=60s に収まらず、監査ログすら残らずに関数が強制終了する（レビュー指摘 I3）。
const MAX_ORDERS_PER_RUN = 50;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// ここで打ち切って残りは翌回に回す。maxDuration の余裕を持って早めに切る。
const TIME_BUDGET_MS = 45_000;

type PendingOrderRow = {
  id: string;
  payment_intent_id: string;
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
 *
 * 認証の失敗は記録する（OWASP Logging Cheat Sheet）。ただし未認証の要求は誰でも送れるので、
 * 1回ごとに監査ログの INSERT と外部アラートを起こすと、それだけでログとアラートを際限なく
 * 増やせる（同 Cheat Sheet の「ログで資源を枯渇させない」、OWASP API4:2023）。
 * - ヘッダの欠落・不一致: アプリのログにだけ残す（ヘッダの値は出さない）
 * - CRON_SECRET 未設定（運用側の設定ミス）: 監査ログにも残す。ただし全体で10分に1回まで
 * 「ジョブが呼ばれていない」「401 で落ちている」は cron.job_run_details と net._http_response で見る。
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

function resolveExpiryDays(): number {
  const raw = Number(process.env.PENDING_ORDER_EXPIRY_DAYS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRY_DAYS;

  if (requested < MIN_EXPIRY_DAYS) {
    console.warn(
      `[cron] PENDING_ORDER_EXPIRY_DAYS=${requested} is below the minimum ${MIN_EXPIRY_DAYS} days (konbini vouchers can stay payable for about 4 days); using ${MIN_EXPIRY_DAYS} instead.`
    );
    return MIN_EXPIRY_DAYS;
  }

  return requested;
}

function resolveDailyBatchOffset(totalOrders: number, nowMs: number): number {
  const batchCount = Math.max(1, Math.ceil(totalOrders / MAX_ORDERS_PER_RUN));
  const utcDay = Math.floor(nowMs / MILLISECONDS_PER_DAY);
  return (utcDay % batchCount) * MAX_ORDERS_PER_RUN;
}


export async function POST(request: Request) {
  const auth = checkAuthorization(request);
  if (!auth.ok) {
    await recordUnauthorized(request, auth);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServiceRoleClient();
  const stripe = getStripeServerClient();

  const threshold = new Date(Date.now() - resolveExpiryDays() * 24 * 60 * 60 * 1000).toISOString();

  const { count: pendingOrderCountValue, error: countError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .lt('created_at', threshold);

  if (countError) {
    console.error('[cron] failed to count pending orders', countError);
    return NextResponse.json({ error: 'Failed to list pending orders' }, { status: 500 });
  }

  const pendingOrderCount = pendingOrderCountValue ?? 0;
  let batchOffset = resolveDailyBatchOffset(pendingOrderCount, Date.now());

  const loadBatch = (offset: number) => supabase
    .from('orders')
    .select('id, payment_intent_id, checkout_session_id')
    .eq('status', 'pending')
    .lt('created_at', threshold)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + MAX_ORDERS_PER_RUN - 1);

  let { data, error } = await loadBatch(batchOffset);

  // count と一覧取得の間に webhook が注文を paid/failed にした場合、選択した範囲が
  // 空になることがある。その日の処理を丸ごと失わないよう先頭範囲へ1回だけ戻す。
  if (!error && batchOffset > 0 && (data?.length ?? 0) === 0) {
    batchOffset = 0;
    ({ data, error } = await loadBatch(batchOffset));
  }

  if (error) {
    console.error('[cron] failed to list pending orders', error);
    return NextResponse.json({ error: 'Failed to list pending orders' }, { status: 500 });
  }

  const orders = (data ?? []) as PendingOrderRow[];
  let cancelled = 0;
  let recoveredAsPaid = 0;
  // このジョブが読んだ後に、ほかの経路（webhook）が先に paid にしていた件数（FREQ-386）
  let alreadyPaid = 0;
  let skippedProcessing = 0;
  let skippedUncancelable = 0;
  let skippedUnknown = 0;
  let failed = 0;
  const failedOrderIds: string[] = [];
  const startedAt = Date.now();
  let timeBudgetExhausted = false;
  let processedCount = 0;

  for (const order of orders) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      timeBudgetExhausted = true;
      break;
    }

    processedCount += 1;

    if (!order.payment_intent_id) {
      failed += 1;
      failedOrderIds.push(order.id);
      continue;
    }

    try {
      // PaymentIntent の取得に失敗した状態では、未入金を証明できない。
      // resource_missing も決済状態ではないため、ほかのStripeエラーと同様に
      // この注文を変更せず failed として監査対象へ残す。
      const paymentIntent = await stripe.paymentIntents.retrieve(order.payment_intent_id);
      const status = paymentIntent.status;

      if (status === 'succeeded') {
        // webhook を取りこぼして pending のまま残った入金済み注文の救済
        const { data: paidRows, error: updateError } = await supabase
          .from('orders')
          .update({ status: 'paid' })
          .eq('id', order.id)
          .eq('status', 'pending')
          .select('id');

        if (updateError) {
          console.error('[cron] failed to mark order paid', order.id, updateError);
          failed += 1;
          failedOrderIds.push(order.id);
          continue;
        }

        // 更新できた行が無いなら、この一覧を読んだ後に webhook が先に paid にしている。
        if ((paidRows?.length ?? 0) === 0) {
          alreadyPaid += 1;
          continue;
        }

        recoveredAsPaid += 1;
        await sendPaidConfirmationEmailForOrder(supabase, order.id);
        continue;
      }

      if (status === 'processing') {
        skippedProcessing += 1;
        continue;
      }

      if (status === 'canceled') {
        const { error: releaseError } = await supabase.rpc('release_stock_for_unpaid_order', {
          _payment_intent_id: order.payment_intent_id,
        });

        if (releaseError) {
          throw new Error(releaseError.message);
        }

        cancelled += 1;
        continue;
      }

      if (!isPendingCheckoutPaymentIntentStatus(status)) {
        console.warn('[cron] unknown PaymentIntent status, skipping', order.id, status);
        skippedUnknown += 1;
        continue;
      }

      const expiry = await expireCheckoutSessionForPaymentIntent({
        stripe,
        paymentIntentId: order.payment_intent_id,
        checkoutSessionId: order.checkout_session_id,
      });

      if (expiry.outcome === 'blocked') {
        console.warn(
          '[cron] Checkout Session is not expireable; preserving order and stock',
          order.id,
          expiry.sessionStatus,
          expiry.paymentStatus,
        );
        skippedUncancelable += 1;
        continue;
      }

      if (expiry.outcome === 'unavailable') {
        throw new Error(`Checkout Session could not be verified: ${expiry.reason}`);
      }

      const { error: releaseError } = await supabase.rpc('release_stock_for_unpaid_order', {
        _payment_intent_id: order.payment_intent_id,
      });

      if (releaseError) {
        throw new Error(releaseError.message);
      }

      cancelled += 1;
    } catch (orderError) {
      // 1件の失敗で残りを止めない。状態を確定できない注文は変更せず、次回実行と
      // 監査ログで再確認できるようにする。
      console.error('[cron] failed to expire pending order', order.id, orderError);
      failed += 1;
      failedOrderIds.push(order.id);
    }
  }

  const capped = pendingOrderCount > MAX_ORDERS_PER_RUN;

  const summary = {
    processed: processedCount,
    candidateCount: pendingOrderCount,
    batchOffset,
    cancelled,
    recoveredAsPaid,
    alreadyPaid,
    skippedProcessing,
    skippedUncancelable,
    skippedUnknown,
    failed,
    capped,
    timeBudgetExhausted,
  };

  // 時間切れで途中終了した場合でも、この監査行だけは必ず残す（レビュー指摘 I3）。
  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: failed > 0
      ? 'error'
      : skippedUncancelable > 0 || skippedUnknown > 0 || timeBudgetExhausted
        ? 'failure'
        : 'success',
    detail: 'Expired pending orders sweep',
    metadata: { ...summary, failed_order_ids: failedOrderIds.slice(0, 20) },
  });

  return NextResponse.json(summary);
}

type ServiceRoleClient = Awaited<ReturnType<typeof createServiceRoleClient>>;

/**
 * async_payment_succeeded webhook を取りこぼして pending のまま残っていた注文を、
 * この掃除ジョブが paid へ昇格させたときに送る入金確認メール（レビュー指摘 I6b）。
 * 組み立ては webhook と共通（明細が引けなければ空リストのまま送らない）。
 */
async function sendPaidConfirmationEmailForOrder(
  supabase: ServiceRoleClient,
  orderId: string
): Promise<void> {
  await sendOrderConfirmationEmailForOrderId({
    store: supabase,
    orderId,
    paymentState: 'paid',
    logLabel: '[cron]',
  });
}
