/** @jest-environment node */
/**
 * 注文が無い支払いの返金が失敗・取消になったときの要対応（src/lib/stripe/refund-failure-exception.ts）を、
 * 実際の PostgREST（ローカル Supabase の API）に通す。要対応の記録・送信権の RPC、reason と detail の CHECK、
 * (payment_ref, reason) の一意制約、未送信の一覧は本物。メールの送信（sendShopAlert）だけを偽物にする。
 *
 * 単体テストは Supabase を偽物にするので、CHECK（detail は英小文字・数字・_ の64文字まで）や一意制約による
 * 「同じ返金は1行・1通」は確かめられない。本番では、返金の失敗のたびに記録が失敗して、イベントが再試行され続ける。
 *
 * 後片付けはしない（ほかの DB 結合テストと同じ）。使い捨てのローカル DB でだけ動かす
 * （DATABASE_URL・LOCAL_SUPABASE_URL が localhost 以外なら失敗させる）。残った行は次の npx supabase db reset で消える。
 *
 * 実行方法（ローカル Supabase を起動しておく）:
 *   eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     npx jest tests/integration/db/refund_failure_exception_postgrest --runInBand
 */
jest.mock('next/headers', () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ReconcilerMailer } from '@/lib/stripe/checkout-payment-reconciler';
import {
  createSupabaseReconcilerDatabase,
  listUnsentShopAlerts,
} from '@/lib/stripe/checkout-payment-reconciler-deps';
import { raiseRefundFailureWithoutOrder } from '@/lib/stripe/refund-failure-exception';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { uniqueSuffix } from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;

describeLocalDb('integration: 注文が無い支払いの返金の失敗を、実際の PostgREST の要対応に通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('試験の行が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;

  beforeAll(() => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  });

  const exceptionRowsOf = async (paymentRef: string) =>
    (
      await db().query(
        `select reason, detail, payment_ref, payment_intent_id, checkout_session_id, order_id, detection_count,
                shop_notified_at is not null as notified, resolved_at is not null as resolved
         from public.payment_exceptions where payment_ref = $1`,
        [paymentRef],
      )
    ).rows;

  const depsWith = (sendShopAlert: jest.Mock) => ({
    database: createSupabaseReconcilerDatabase(client),
    mailer: { sendShopAlert } as unknown as ReconcilerMailer,
    now: () => new Date(),
  });

  test('既存の理由で1行だけ記録し、店へ1回だけ知らせる（同じ返金の再通知・解決済みは増やさず、別の返金は別の行にする）', async () => {
    const refundId = `re_pgrst_${uniqueSuffix()}`;
    const paymentIntentId = `pi_pgrst_${uniqueSuffix()}`;
    const sendShopAlert = jest.fn().mockResolvedValue(true);
    const deps = depsWith(sendShopAlert);
    const input = { paymentIntentId, refundId, refundStatus: 'failed' } as const;

    const first = await raiseRefundFailureWithoutOrder(deps, input);

    expect(first.isNew).toBe(true);
    expect(await exceptionRowsOf(refundId)).toEqual([{
      reason: 'unexpected_state',
      detail: 'refund_failed_without_order',
      payment_ref: refundId,
      payment_intent_id: paymentIntentId,
      checkout_session_id: null,
      order_id: null,
      detection_count: 1,
      notified: true,
      resolved: false,
    }]);
    expect(sendShopAlert).toHaveBeenCalledTimes(1);
    expect(sendShopAlert).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'unexpected_state',
      detail: 'refund_failed_without_order',
      orderId: null,
      paymentRef: refundId,
    }));

    // 同じ返金のイベントが再び届いても、行も通知も増えない
    expect(await raiseRefundFailureWithoutOrder(deps, input)).toEqual({ exceptionId: first.exceptionId, isNew: false });
    expect(await exceptionRowsOf(refundId)).toMatchObject([{ detection_count: 2, notified: true }]);
    expect(sendShopAlert).toHaveBeenCalledTimes(1);

    // 解決済みにしたあとに検知しても、知らせ直さない
    await db().query('update public.payment_exceptions set resolved_at = now() where id = $1', [first.exceptionId]);
    await raiseRefundFailureWithoutOrder(deps, input);
    expect(await exceptionRowsOf(refundId)).toMatchObject([{ detection_count: 3, resolved: true }]);
    expect(sendShopAlert).toHaveBeenCalledTimes(1);

    // 同じ支払いの別の返金が取消になったら、別の要対応として知らせる
    const otherRefundId = `re_pgrst_${uniqueSuffix()}`;
    await raiseRefundFailureWithoutOrder(deps, { paymentIntentId, refundId: otherRefundId, refundStatus: 'canceled' });
    expect(await exceptionRowsOf(otherRefundId)).toMatchObject([
      { detail: 'refund_canceled_without_order', payment_intent_id: paymentIntentId, detection_count: 1, notified: true },
    ]);
    expect(sendShopAlert).toHaveBeenCalledTimes(2);
  });

  test('店へのメールが送れなければ未送信の一覧に残り、毎時の見回りが送り直せる', async () => {
    const refundId = `re_pgrst_${uniqueSuffix()}`;
    const deps = depsWith(jest.fn().mockResolvedValue(false));

    const raised = await raiseRefundFailureWithoutOrder(deps, {
      paymentIntentId: `pi_pgrst_${uniqueSuffix()}`,
      refundId,
      refundStatus: 'failed',
    });

    expect(await exceptionRowsOf(refundId)).toMatchObject([{ notified: false }]);
    const unsent = (await listUnsentShopAlerts(client, 1000)).find((entry) => entry.exceptionId === raised.exceptionId);
    expect(unsent?.alert).toMatchObject({
      reason: 'unexpected_state',
      detail: 'refund_failed_without_order',
      orderId: null,
      paymentRef: refundId,
    });
  });
});
